// macOS global input capture for the quick-help wheel.
//
// An event tap is the only way on macOS to see a key or a click while another
// application is in front. It needs Accessibility permission; without it the tap
// simply cannot be created, and this process says so rather than failing quietly.
//
// Design notes that matter more than the code:
//
//  - The tap runs on its own thread with its own run loop. The main thread reads
//    commands from stdin and posts them into the tap thread, so a slow consumer
//    can never delay the callback — a callback that takes too long gets the tap
//    disabled by the system, and the fix is to answer in microseconds.
//  - Events this process posts itself are marked in `kCGEventSourceUserData` and
//    ignored, so replaying a click cannot feed back into the state machine.
//  - Closing stdin means the host is gone. The tap is removed and the process
//    exits, so an application is never left with its input captured by a process
//    nobody is listening to.

#include <ApplicationServices/ApplicationServices.h>
#include <CoreFoundation/CoreFoundation.h>
#include <unistd.h>

#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#include "decision.h"
#include "protocol.h"

namespace {

// Marks events this process posts, so they are recognised and skipped.
constexpr int64_t kSelfMarker = 0x64736851; // 'dshQ'

dsh::DecisionState g_state;
dsh::Config g_config;
Protocol g_protocol;
std::mutex g_state_mutex;
CFRunLoopRef g_tap_run_loop = nullptr;
CFMachPortRef g_tap_port = nullptr;
CFRunLoopSourceRef g_tap_source = nullptr;
CFRunLoopTimerRef g_tap_timer = nullptr;
uint64_t g_last_input_ms = 0;
bool g_ready_sent = false;
bool g_trigger_key_captured = false;
bool g_space_key_captured = false;
bool g_escape_key_captured = false;
bool g_left_mouse_captured = false;
bool g_control_down = false;
CGEventRef g_captured_left_down = nullptr;
CGEventRef g_captured_trigger_down = nullptr;
std::vector<CGEventRef> g_pending_space_events;
constexpr size_t kMaxBufferedSpaceEvents = 64;
constexpr uint64_t kSpaceTapGraceMs = 500;
uint64_t g_space_capture_started_ms = 0;

// Monotonic milliseconds, used only for the watchdog.
uint64_t now_ms() {
  return static_cast<uint64_t>(CFAbsoluteTimeGetCurrent() * 1000.0);
}

/**
 * Whether this keystroke is the trigger chord.
 *
 * The test itself lives in `decision.cpp` so it can be exercised without a running
 * event tap. This wrapper only lifts the two fields it needs out of the CGEvent.
 */
bool is_trigger_chord(CGEventRef event) {
  const uint16_t keycode = static_cast<uint16_t>(
      CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode));
  const uint32_t flags = static_cast<uint32_t>(CGEventGetFlags(event));
  return dsh::chord_matches(g_config, keycode, flags);
}

uint16_t keycode_of(CGEventRef event);

bool is_bare_space(CGEventRef event) {
  constexpr uint32_t kTypingModifiers = kCGEventFlagMaskShift | kCGEventFlagMaskControl |
      kCGEventFlagMaskAlternate | kCGEventFlagMaskCommand;
  return keycode_of(event) == 49 &&
      (static_cast<uint32_t>(CGEventGetFlags(event)) & kTypingModifiers) == 0;
}

void release_pending_space_events() {
  for (CGEventRef event : g_pending_space_events) CFRelease(event);
  g_pending_space_events.clear();
}

void discard_pending_space_events() { release_pending_space_events(); }

void replay_pending_space_events() {
  for (CGEventRef event : g_pending_space_events) {
    CGEventSetIntegerValueField(event, kCGEventSourceUserData, kSelfMarker);
    CGEventPost(kCGHIDEventTap, event);
    CFRelease(event);
  }
  g_pending_space_events.clear();
}

bool buffer_space_event(CGEventRef event) {
  if (g_pending_space_events.size() >= kMaxBufferedSpaceEvents) return false;
  CGEventRef copy = CGEventCreateCopy(event);
  if (copy == nullptr) return false;
  g_pending_space_events.push_back(copy);
  return true;
}

void clear_space_capture() {
  g_space_key_captured = false;
  g_space_capture_started_ms = 0;
}

void clear_trigger_capture() {
  g_trigger_key_captured = false;
  if (g_captured_trigger_down != nullptr) {
    CFRelease(g_captured_trigger_down);
    g_captured_trigger_down = nullptr;
  }
}

void clear_left_mouse_capture() {
  g_left_mouse_captured = false;
  if (g_captured_left_down != nullptr) {
    CFRelease(g_captured_left_down);
    g_captured_left_down = nullptr;
  }
}

void replay_left_mouse_down() {
  if (g_captured_left_down != nullptr) {
    CGEventRef replay = CGEventCreateCopy(g_captured_left_down);
    if (replay != nullptr) {
      CGEventSetIntegerValueField(replay, kCGEventSourceUserData, kSelfMarker);
      CGEventPost(kCGHIDEventTap, replay);
      CFRelease(replay);
    }
  }
  clear_left_mouse_capture();
}

void replay_trigger_down() {
  if (g_captured_trigger_down == nullptr) return;
  CGEventRef replay = CGEventCreateCopy(g_captured_trigger_down);
  if (replay != nullptr) {
    CGEventSetIntegerValueField(replay, kCGEventSourceUserData, kSelfMarker);
    CGEventPost(kCGHIDEventTap, replay);
    CFRelease(replay);
  }
  clear_trigger_capture();
}

void apply_config(const dsh::Config& config) {
  const bool changed = g_config.enabled != config.enabled ||
      g_config.trigger_vk != config.trigger_vk ||
      g_config.modifier_mask != config.modifier_mask ||
      g_config.hold_mode != config.hold_mode;
  if (changed) {
    const dsh::Phase phase = g_state.phase();
    if (phase == dsh::Phase::Wheel) g_protocol.send_cancel();
    if (g_space_key_captured && phase == dsh::Phase::Pending) {
      replay_pending_space_events();
      clear_space_capture();
    }
    if (g_trigger_key_captured) replay_trigger_down();
    if (phase != dsh::Phase::Idle) g_state.reset();
    g_control_down = (CGEventSourceFlagsState(kCGEventSourceStateHIDSystemState) &
        kCGEventFlagMaskControl) != 0;
    // An already-open Space gesture remains captured through its physical release;
    // its swallowed down must not be followed by a stray application key-up.
  }
  g_config = config;
  g_state.configure(config);
}

/** Key code of an event, for the paths that only need that half. */
uint16_t keycode_of(CGEventRef event) {
  return static_cast<uint16_t>(CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode));
}

dsh::MouseButton button_of(CGEventRef event) {
  switch (CGEventGetIntegerValueField(event, kCGMouseEventButtonNumber)) {
    case kCGMouseButtonLeft: return dsh::MouseButton::Left;
    case kCGMouseButtonRight: return dsh::MouseButton::Right;
    case kCGMouseButtonCenter: return dsh::MouseButton::Middle;
    default: return dsh::MouseButton::None;
  }
}

CGPoint point_of(CGEventRef event) { return CGEventGetLocation(event); }

// Post a click the wheel declined to claim, so the application underneath sees
// the press and the release it would have seen anyway.
void replay_click(CGPoint point, CGEventType down_type) {
  CGEventRef down = CGEventCreateMouseEvent(nullptr, down_type, point, kCGMouseButtonLeft);
  if (down == nullptr) return;
  CGEventSetIntegerValueField(down, kCGEventSourceUserData, kSelfMarker);
  CGEventPost(kCGHIDEventTap, down);
  CFRelease(down);

  CGEventRef up = CGEventCreateMouseEvent(nullptr, kCGEventLeftMouseUp, point, kCGMouseButtonLeft);
  if (up == nullptr) return;
  CGEventSetIntegerValueField(up, kCGEventSourceUserData, kSelfMarker);
  CGEventPost(kCGHIDEventTap, up);
  CFRelease(up);
}

// True when this event is one we posted ourselves.
bool is_self(CGEventRef event) {
  return CGEventGetIntegerValueField(event, kCGEventSourceUserData) == kSelfMarker;
}

CGEventRef tap_callback(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void* user_data) {
  (void)proxy;
  (void)user_data;
  const std::lock_guard<std::mutex> state_lock(g_state_mutex);

  // The system disables a tap that takes too long, or that the user interrupts.
  // Re-enabling it is mandatory: without this the wheel silently stops working
  // and nothing on screen says why.
  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
    const bool was_wheel = g_state.phase() == dsh::Phase::Wheel;
    if (was_wheel) g_protocol.send_cancel();
    // A disabled tap stops receiving paired releases. Put a buffered Space-down
    // back before letting subsequent physical events pass, then forget every
    // captured key so a restarted tap cannot swallow an unrelated key-up.
    if (g_space_key_captured) {
      if (g_state.phase() == dsh::Phase::Wheel && g_pending_space_events.empty()) {
        CGEventRef down = CGEventCreateKeyboardEvent(nullptr, 49, true);
        if (down != nullptr) {
          CGEventSetIntegerValueField(down, kCGEventSourceUserData, kSelfMarker);
          CGEventPost(kCGHIDEventTap, down);
          CFRelease(down);
        }
      }
      replay_pending_space_events();
      clear_space_capture();
    }
    if (g_trigger_key_captured) replay_trigger_down();
    else clear_trigger_capture();
    if (dsh::control_only(g_config)) {
      g_state.reset();
      g_control_down = (CGEventSourceFlagsState(kCGEventSourceStateHIDSystemState) &
          kCGEventFlagMaskControl) != 0;
    }
    // The physical mouse-up will pass after the tap restarts. Restore its
    // swallowed down first so the application never sees half a click.
    if (g_left_mouse_captured) replay_left_mouse_down();
    g_escape_key_captured = false;
    g_state.on_escape();
    if (g_state.trigger_down() &&
        !CGEventSourceKeyState(kCGEventSourceStateHIDSystemState, g_config.trigger_vk)) {
      // The tap may have missed the physical key-up while disabled. Reconcile
      // from the HID state so one lost release cannot permanently lock the wheel.
      g_state.on_trigger_up();
    }
    if (g_tap_port != nullptr && CFMachPortIsValid(g_tap_port)) {
      CGEventTapEnable(g_tap_port, true);
    }
    return event;
  }
  if (is_self(event)) return event;

  g_last_input_ms = now_ms();
  g_state.note_input(g_last_input_ms);

  switch (type) {
    case kCGEventKeyDown: {
      const uint16_t keycode = keycode_of(event);
      if (dsh::control_only(g_config) && g_control_down) {
        if (g_state.phase() == dsh::Phase::Wheel) g_protocol.send_cancel();
        g_state.on_escape();
        return event; // Ctrl+C/V/A/Z/Tab and every other chord belong to the app.
      }
      // A bare Space is a gesture candidate, not a global shortcut. Buffer its
      // down/repeat events until either pointer movement turns it into a wheel,
      // or release/another key proves the user meant ordinary text input.
      if (g_space_key_captured) {
        if (!g_config.enabled && is_bare_space(event)) return nullptr;
        if (g_state.phase() == dsh::Phase::Pending && !is_bare_space(event)) {
          replay_pending_space_events();
          clear_space_capture();
          g_state.on_escape();
          return event;
        }
        if (is_bare_space(event) &&
            (g_state.phase() == dsh::Phase::Pending || g_state.phase() == dsh::Phase::Wheel)) {
          if (g_state.phase() == dsh::Phase::Pending && buffer_space_event(event)) return nullptr;
          if (g_state.phase() == dsh::Phase::Wheel) return nullptr;
          replay_pending_space_events();
          clear_space_capture();
          g_state.on_escape();
          return event;
        }
        // Escape/watchdog may close the wheel while Space remains physically
        // down. Keep swallowing its repeats until the matching key-up arrives.
        if (is_bare_space(event) && g_state.phase() == dsh::Phase::Idle) return nullptr;
      }
      if (!g_config.enabled && g_trigger_key_captured && keycode_of(event) == g_config.trigger_vk) return nullptr;
      if (g_config.enabled && g_config.hold_mode && g_config.trigger_vk == 49 &&
          g_config.modifier_mask == 0 && is_bare_space(event)) {
        // A tap timeout/watchdog can replay the original down and clear capture;
        // do not treat an OS repeat as a fresh gesture before physical key-up.
        if (g_state.trigger_down()) return event;
        const CGPoint point = point_of(event);
        if (!buffer_space_event(event)) return event;
        g_space_key_captured = true;
        g_space_capture_started_ms = now_ms();
        g_state.on_trigger_down(point.x, point.y);
        return nullptr;
      }
      if (g_state.phase() == dsh::Phase::Pending) {
        // Other key input cancels arming and is replayed after the buffered
        // Space-down, preserving the user's original sequence.
        replay_pending_space_events();
        clear_space_capture();
        g_state.on_escape();
      }
      if (keycode == 53 && g_state.phase() == dsh::Phase::Wheel) {
        g_state.on_escape();
        g_protocol.send_cancel();
        g_escape_key_captured = true;
        return nullptr;
      }
      if (is_trigger_chord(event)) {
        clear_trigger_capture();
        g_trigger_key_captured = true;
        g_captured_trigger_down = CGEventCreateCopy(event);
        const CGPoint point = point_of(event);
        const dsh::Phase before = g_state.phase();
        g_state.on_trigger_down(point.x, point.y);
        if (before != dsh::Phase::Wheel && g_state.phase() == dsh::Phase::Wheel) {
          g_protocol.send_wheel_open(g_state.anchor_x(), g_state.anchor_y());
        }
        // Swallowed: the chord belongs to the wheel. A bare Option would otherwise
        // open the menu bar on the way past.
        return nullptr;
      }
      // Anything else — including the trigger key pressed *without* its
      // modifiers — passes through untouched. That is what leaves the space bar
      // working after the user binds Control+Option+Space.
      return event;
    }
    case kCGEventKeyUp: {
      if (g_space_key_captured && keycode_of(event) == 49) {
        const dsh::Phase before = g_state.phase();
        if (before == dsh::Phase::Pending) {
          if (!buffer_space_event(event)) {
            // If the release cannot be copied, replay the swallowed presses and
            // let this original release reach the application to keep the pair.
            replay_pending_space_events();
            clear_space_capture();
            g_state.on_trigger_up();
            return event;
          }
          replay_pending_space_events();
          clear_space_capture();
          g_state.on_trigger_up();
          return nullptr;
        }
        if (before == dsh::Phase::Wheel) {
          discard_pending_space_events();
          clear_space_capture();
          g_state.on_trigger_up();
          const CGPoint point = point_of(event);
          g_protocol.send_wheel_release(point.x, point.y);
          return nullptr;
        }
        replay_pending_space_events();
        clear_space_capture();
        g_state.on_trigger_up();
        return nullptr;
      }
      if (g_escape_key_captured && keycode_of(event) == 53) {
        g_escape_key_captured = false;
        return nullptr;
      }
      if (g_trigger_key_captured && keycode_of(event) == g_config.trigger_vk) {
        clear_trigger_capture();
        const dsh::Phase before = g_state.phase();
        g_state.on_trigger_up();
        if (before == dsh::Phase::Wheel && g_config.hold_mode) {
          const CGPoint point = point_of(event);
          g_protocol.send_wheel_release(point.x, point.y);
        }
        return nullptr;
      }
      const uint16_t keycode = keycode_of(event);
      // Cancel and watchdog paths may have cleared the capture bookkeeping while
      // the physical chord is still held. Its real release is still authoritative
      // for clearing the state-machine latch.
      if (g_state.trigger_down() && keycode == g_config.trigger_vk) {
        const dsh::Phase before = g_state.phase();
        g_state.on_trigger_up();
        if (before == dsh::Phase::Wheel && g_config.hold_mode && keycode != 49) {
          const CGPoint point = point_of(event);
          g_protocol.send_wheel_release(point.x, point.y);
        }
      }
      if (keycode == 53 /* Escape */) {
        const bool was_active = g_state.phase() != dsh::Phase::Idle;
        g_state.on_escape();
        if (was_active) {
          g_protocol.send_cancel();
          return nullptr;
        }
      }
      return event;
    }
    case kCGEventFlagsChanged: {
      if (!dsh::control_only(g_config)) return event;
      const uint32_t flags = static_cast<uint32_t>(CGEventGetFlags(event));
      const bool down = (flags & kCGEventFlagMaskControl) != 0;
      const bool was_down = g_control_down;
      g_control_down = down;
      if (!g_config.enabled) { g_state.reset(); return event; }
      const uint32_t other = kCGEventFlagMaskShift | kCGEventFlagMaskAlternate | kCGEventFlagMaskCommand;
      if (down && (flags & other) != 0) {
        if (g_state.phase() == dsh::Phase::Wheel) g_protocol.send_cancel();
        g_state.on_escape();
      } else if (down && !was_down) {
        // Pressing Control during an existing mouse drag is still that drag.
        const bool mouse_down = CGEventSourceButtonState(kCGEventSourceStateHIDSystemState, kCGMouseButtonLeft) ||
            CGEventSourceButtonState(kCGEventSourceStateHIDSystemState, kCGMouseButtonRight) ||
            CGEventSourceButtonState(kCGEventSourceStateHIDSystemState, kCGMouseButtonCenter);
        if (!mouse_down) {
          const CGPoint point = point_of(event);
          g_state.on_trigger_down(point.x, point.y);
        }
      } else if (!down && was_down) {
        const dsh::Phase before = g_state.phase();
        g_state.on_trigger_up();
        if (before == dsh::Phase::Wheel) {
          const CGPoint point = point_of(event);
          g_protocol.send_wheel_release(point.x, point.y);
        }
      }
      return event; // Never swallow a modifier transition.
    }
      return event;
    case kCGEventLeftMouseDown:
    case kCGEventRightMouseDown:
    case kCGEventOtherMouseDown: {
      if (dsh::control_only(g_config) && g_control_down) {
        if (g_state.phase() == dsh::Phase::Wheel) g_protocol.send_cancel();
        g_state.on_escape();
        return event; // Control+click must remain a normal application click.
      }
      const CGPoint point = point_of(event);
      const dsh::MouseButton button = button_of(event);
      const dsh::Phase before = g_state.phase();
      g_state.on_mouse_down(point.x, point.y, button);
      if (before == dsh::Phase::Wheel && g_state.phase() == dsh::Phase::Idle) {
        g_protocol.send_cancel();
      }
      if (button == dsh::MouseButton::Left && g_state.holds_swallowed_press()) {
        g_left_mouse_captured = true;
        if (g_captured_left_down != nullptr) CFRelease(g_captured_left_down);
        g_captured_left_down = CGEventCreateCopy(event);
      }
      const bool opened = g_state.phase() == dsh::Phase::Wheel && before != dsh::Phase::Wheel;
      if (opened) {
        g_protocol.send_wheel_open(g_state.anchor_x(), g_state.anchor_y());
        return nullptr;
      }
      if (button == dsh::MouseButton::Left && g_left_mouse_captured) return nullptr;
      if (g_state.holds_swallowed_press()) return nullptr;
      return event;
    }
    case kCGEventScrollWheel:
      if (dsh::control_only(g_config) && g_control_down) {
        if (g_state.phase() == dsh::Phase::Wheel) g_protocol.send_cancel();
        g_state.on_escape();
      }
      return event;
    case kCGEventLeftMouseDragged:
    case kCGEventRightMouseDragged:
    case kCGEventOtherMouseDragged: {
      if (dsh::control_only(g_config) && g_control_down) {
        if (g_state.phase() == dsh::Phase::Wheel) g_protocol.send_cancel();
        g_state.on_escape();
        return event;
      }
      const CGPoint point = point_of(event);
      const dsh::Phase before = g_state.phase();
      g_state.on_mouse_move(point.x, point.y);
      if (before != dsh::Phase::Wheel && g_state.phase() == dsh::Phase::Wheel) {
        discard_pending_space_events();
        g_protocol.send_wheel_open(g_state.anchor_x(), g_state.anchor_y());
      }
      if (g_state.phase() == dsh::Phase::Wheel) {
        g_protocol.send_wheel_move(point.x, point.y);
      }
      // Drag is always passed through, matching what a real cursor does.
      return event;
    }
    case kCGEventMouseMoved: {
      const CGPoint point = point_of(event);
      const dsh::Phase before = g_state.phase();
      g_state.on_mouse_move(point.x, point.y);
      if (before != dsh::Phase::Wheel && g_state.phase() == dsh::Phase::Wheel) {
        discard_pending_space_events();
        g_protocol.send_wheel_open(g_state.anchor_x(), g_state.anchor_y());
      }
      if (g_state.phase() == dsh::Phase::Wheel) g_protocol.send_wheel_move(point.x, point.y);
      return event;
    }
    case kCGEventLeftMouseUp: {
      const CGPoint point = point_of(event);
      const bool was_held = g_left_mouse_captured;
      const dsh::Phase before = g_state.phase();
      g_state.on_mouse_up(point.x, point.y, dsh::MouseButton::Left);
      if (was_held) {
        if (before == dsh::Phase::Wheel) g_protocol.send_wheel_release(point.x, point.y);
        // The release of a press this process swallowed is swallowed too, or
        // replayed when the gesture never became a wheel.
        if (before == dsh::Phase::Pending) replay_click(point, kCGEventLeftMouseDown);
        clear_left_mouse_capture();
        return nullptr;
      }
      return event;
    }
    default:
      return event;
  }
}

void watchdog_timer(CFRunLoopTimerRef timer, void* info) {
  (void)timer;
  (void)info;
  const std::lock_guard<std::mutex> state_lock(g_state_mutex);
  if (g_space_key_captured && g_state.phase() == dsh::Phase::Pending &&
      now_ms() - g_space_capture_started_ms >= kSpaceTapGraceMs) {
    // A held Space with no movement is normal input (for example, a game or
    // media player). Bound the delay so it cannot remain buffered while held.
    replay_pending_space_events();
    clear_space_capture();
    g_state.on_escape();
  }
  const dsh::Phase phase_before_tick = g_state.phase();
  const dsh::Decision decision = g_state.on_tick(now_ms());
  if (decision.cancel) {
    g_protocol.send_cancel();
    if (phase_before_tick == dsh::Phase::Pending && g_space_key_captured) {
      replay_pending_space_events();
      clear_space_capture();
    }
    if (phase_before_tick == dsh::Phase::Wheel && g_left_mouse_captured) replay_left_mouse_down();
  }
  if (decision.sink == dsh::Sink::Replay) {
    // Nothing to replay at the OS level here: the tap layer replays on the next
    // real release; this only clears the held state.
  }
}

void install_config(const std::string& line) {
  const std::lock_guard<std::mutex> state_lock(g_state_mutex);
  // The host owns configuration; an unparsable line leaves the current config in
  // place rather than disabling the wheel on a typo.
  int trigger_vk = 0;
  unsigned int modifier_mask = 0;
  int hold_mode = 0;
  int enabled = 1;
  double threshold = 12.0;
  int watchdog_ms = 10000;
  const int matched = std::sscanf(line.c_str(),
                                  "{\"type\":\"config\",\"triggerVk\":%d,\"modifierMask\":%u,"
                                  "\"holdMode\":%d,\"dragThreshold\":%lf,\"watchdogMs\":%d,\"enabled\":%d",
                                  &trigger_vk, &modifier_mask, &hold_mode, &threshold, &watchdog_ms, &enabled);
  // A partial match would leave the modifier mask at zero, which silently widens
  // the trigger to the bare key — the exact failure this field exists to prevent.
  // Refusing the update keeps the last known-good chord instead.
  if (matched != 6) return;
  dsh::Config config;
  config.trigger_vk = static_cast<uint16_t>(trigger_vk);
  config.modifier_mask = static_cast<uint32_t>(modifier_mask);
  config.hold_mode = hold_mode != 0;
  config.drag_threshold = threshold;
  config.watchdog_ms = static_cast<uint32_t>(watchdog_ms);
  config.enabled = enabled != 0;
  apply_config(config);
}

void* run_tap_thread(void* arg) {
  (void)arg;
  // Try the actual capability first. AXIsProcessTrusted is a useful diagnostic,
  // but it is not the capability itself and may disagree with a tap that the OS
  // permits for this process. Never reject a usable tap based on a preflight.
  CFMachPortRef tap = CGEventTapCreate(
      kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionDefault,
      CGEventMaskBit(kCGEventKeyDown) | CGEventMaskBit(kCGEventKeyUp) |
          CGEventMaskBit(kCGEventFlagsChanged) |
          CGEventMaskBit(kCGEventLeftMouseDown) | CGEventMaskBit(kCGEventLeftMouseUp) |
          CGEventMaskBit(kCGEventRightMouseDown) | CGEventMaskBit(kCGEventOtherMouseDown) |
          CGEventMaskBit(kCGEventScrollWheel) |
          CGEventMaskBit(kCGEventLeftMouseDragged) | CGEventMaskBit(kCGEventRightMouseDragged) |
          CGEventMaskBit(kCGEventOtherMouseDragged) | CGEventMaskBit(kCGEventMouseMoved),
      tap_callback, nullptr);
  if (tap == nullptr) {
    const bool trusted = AXIsProcessTrusted();
    if (!trusted) {
      g_protocol.send_error("no_access",
          "系统拒绝输入助手创建全局事件监听器，且输入助手自身未获设备控制权限。请在“设备控制和数据访问”中添加当前应用内的 quick-help/input-helper。"
      );
    } else {
      g_protocol.send_error("tap_failed", "系统未创建全局输入事件监听器；输入助手已获信任，请检查签名身份与系统事件监听状态。");
    }
    return nullptr;
  }
  g_tap_run_loop = CFRunLoopGetCurrent();
  CFRetain(g_tap_run_loop);
  g_tap_port = tap;
  g_tap_source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0);
  if (g_tap_source == nullptr) {
    g_tap_port = nullptr;
    g_tap_run_loop = nullptr;
    CFRelease(CFRunLoopGetCurrent());
    CFMachPortInvalidate(tap);
    CFRelease(tap);
    g_protocol.send_error("tap_failed", "无法创建全局输入监听器的运行循环源。");
    return nullptr;
  }
  CFRunLoopAddSource(g_tap_run_loop, g_tap_source, kCFRunLoopCommonModes);
  g_tap_timer =
      CFRunLoopTimerCreate(kCFAllocatorDefault, CFAbsoluteTimeGetCurrent() + 0.05,
                           0.05, 0, 0, watchdog_timer, nullptr);
  if (g_tap_timer == nullptr) {
    CFRunLoopRemoveSource(g_tap_run_loop, g_tap_source, kCFRunLoopCommonModes);
    CFRelease(g_tap_source);
    g_tap_source = nullptr;
    g_tap_port = nullptr;
    CFRunLoopRef run_loop = g_tap_run_loop;
    g_tap_run_loop = nullptr;
    CFRelease(run_loop);
    CFMachPortInvalidate(tap);
    CFRelease(tap);
    g_protocol.send_error("tap_failed", "无法创建全局输入监听器的监视器。");
    return nullptr;
  }
  CFRunLoopAddTimer(g_tap_run_loop, g_tap_timer, kCFRunLoopCommonModes);

  g_protocol.send_ready();
  g_ready_sent = true;
  CFRunLoopRun();

  const std::lock_guard<std::mutex> state_lock(g_state_mutex);
  if (g_tap_timer != nullptr) {
    CFRunLoopRemoveTimer(g_tap_run_loop, g_tap_timer, kCFRunLoopCommonModes);
    CFRunLoopTimerInvalidate(g_tap_timer);
    CFRelease(g_tap_timer);
    g_tap_timer = nullptr;
  }
  if (g_tap_source != nullptr) {
    CFRunLoopRemoveSource(g_tap_run_loop, g_tap_source, kCFRunLoopCommonModes);
    CFRunLoopSourceInvalidate(g_tap_source);
    CFRelease(g_tap_source);
    g_tap_source = nullptr;
  }
  g_tap_run_loop = nullptr;
  if (g_tap_port != nullptr) {
    CFMachPortInvalidate(g_tap_port);
    CFRelease(g_tap_port);
    g_tap_port = nullptr;
  }
  CFRelease(CFRunLoopGetCurrent());
  return nullptr;
}

}  // namespace

int main() {
  g_last_input_ms = now_ms();
  g_protocol.set_nonblocking_stdout();

  pthread_t thread;
  if (pthread_create(&thread, nullptr, run_tap_thread, nullptr) != 0) {
    g_protocol.send_error("thread", "无法创建输入监听线程。");
    return 4;
  }
  // Give the tap thread a moment to report readiness or the missing permission
  // before the main loop starts consuming commands.
  usleep(150 * 1000);

  char buffer[4096];
  while (std::fgets(buffer, sizeof(buffer), stdin) != nullptr) {
    std::string line(buffer);
    while (!line.empty() && (line.back() == '\n' || line.back() == '\r')) line.pop_back();
    if (line.empty()) continue;
    if (line == "{\"type\":\"shutdown\"}") break;
    if (line.rfind("{\"type\":\"config\"", 0) == 0) {
      install_config(line);
      continue;
    }
    if (line == "{\"type\":\"setEnabled\",\"enabled\":true}" ||
        line == "{\"type\":\"setEnabled\",\"enabled\":false}") {
      const std::lock_guard<std::mutex> state_lock(g_state_mutex);
      dsh::Config config = g_config;
      config.enabled = line.find("true") != std::string::npos;
      apply_config(config);
      continue;
    }
  }

  // The host is gone. Release the tap so the user's keyboard and mouse behave
  // normally again; this is the path that must never be skipped.
  {
    const std::lock_guard<std::mutex> state_lock(g_state_mutex);
    if (g_state.phase() == dsh::Phase::Wheel) g_protocol.send_cancel();
    if (g_space_key_captured && g_state.phase() == dsh::Phase::Wheel &&
        g_pending_space_events.empty()) {
      // The original Space-down was intentionally withheld once the wheel
      // opened. Recreate it on shutdown so the OS can pair the user's eventual
      // physical key-up after the helper exits.
      CGEventRef down = CGEventCreateKeyboardEvent(nullptr, 49, true);
      if (down != nullptr) {
        CGEventSetIntegerValueField(down, kCGEventSourceUserData, kSelfMarker);
        CGEventPost(kCGHIDEventTap, down);
        CFRelease(down);
      }
    }
    replay_pending_space_events();
    clear_space_capture();
    if (g_trigger_key_captured) replay_trigger_down();
    if (g_left_mouse_captured) replay_left_mouse_down();
    g_state.reset();
  }
  g_protocol.send_bye();
  CFRunLoopRef tap_run_loop = nullptr;
  {
    const std::lock_guard<std::mutex> state_lock(g_state_mutex);
    tap_run_loop = g_tap_run_loop;
    if (tap_run_loop != nullptr) CFRetain(tap_run_loop);
  }
  if (tap_run_loop != nullptr) {
    CFRunLoopStop(tap_run_loop);
    CFRunLoopWakeUp(tap_run_loop);
    CFRelease(tap_run_loop);
  }
  pthread_join(thread, nullptr);
  return 0;
}
