// Global input state machine for the quick-help wheel.
//
// Pure logic, no Apple headers, so it can be reasoned about and tested without
// a running event tap. The OS layer feeds it events and obeys what it returns.
//
// The one invariant that matters most: for every button-down this process
// swallows, the matching button-up is swallowed too, or both are replayed. An
// application underneath must never see half a click — a swallowed press whose
// release leaks through is what makes an app select text or click a button the
// user never aimed at.

#ifndef DSH_QUICK_HELP_DECISION_H
#define DSH_QUICK_HELP_DECISION_H

#include <stdbool.h>
#include <stdint.h>

namespace dsh {

// Phases of one gesture.
enum class Phase {
  // Nothing is being tracked; every event passes through untouched.
  Idle,
  // The trigger chord is down but the gesture has not been confirmed yet. Used
  // by press-and-hold mode, where a press with no movement is an ordinary
  // chord the user may still want.
  Pending,
  // The wheel is on screen and following the mouse.
  Wheel,
};

enum class MouseButton { None, Left, Right, Middle };

// What the OS layer should do with an event it just delivered.
enum class Sink {
  // Let the event continue to the application underneath.
  Pass,
  // Consume it: the application underneath must not see it.
  Swallow,
  // Consume it and re-post an equivalent press-then-release, so the application
  // sees a click that the wheel declined to claim.
  Replay,
};

struct Decision {
  Sink sink = Sink::Pass;
  // Set when this event opens the wheel. Carries the *anchor* point, not the
  // current one, because the wheel is drawn where the gesture began.
  bool open_wheel = false;
  bool move_wheel = false;
  bool close_wheel = false;
  bool commit = false;
  bool cancel = false;
  // Reported so the caller can show something useful; never a trust decision.
  int selected_sector = -1;
};

// Configuration, pushed from the host on start and on every settings change.
struct Config {
  // Key code (macOS virtual key code) that opens the wheel.
  uint16_t trigger_vk = 0;
  // CGEventFlags that must ALL be down for a keystroke to count as the trigger.
  // Zero means a bare key with no modifiers. This is what keeps the rest of the
  // keyboard usable: without it, binding Control+Option+Space would swallow every
  // Space in every application, because the key code alone cannot tell them apart.
  uint32_t modifier_mask = 0;
  // True for press-and-hold mode, false for press-to-open mode.
  bool hold_mode = false;
  // Movement in points needed to leave Pending in hold mode.
  double drag_threshold = 12.0;
  // Milliseconds without input before an open wheel gives up on its own.
  uint32_t watchdog_ms = 10000;
  // When false every event passes through; only the trigger chord is watched.
  bool enabled = true;
};

// VK 59 with no modifier mask is reserved for the Control-only gesture.
bool control_only(const Config& config);

class DecisionState {
 public:
  void configure(const Config& config);

  // Chord bookkeeping.
  void on_trigger_down(double x = 0.0, double y = 0.0);
  void on_trigger_up();
  // Any modifier other than the trigger changing state.
  void on_other_modifier();

  // Mouse, in global display coordinates.
  void on_mouse_down(double x, double y, MouseButton button);
  void on_mouse_move(double x, double y);
  void on_mouse_up(double x, double y, MouseButton button);

  void on_escape();
  void note_input(uint64_t now_ms) { last_input_ms_ = now_ms; }

  // Watchdog tick; `now_ms` is a monotonic millisecond counter.
  Decision on_tick(uint64_t now_ms);

  // Reset without emitting anything, used when the wheel is torn down.
  void reset();

  Phase phase() const { return phase_; }
  // True while a press is being held that the OS layer has swallowed, so it
  // knows to swallow the matching release too.
  bool holds_swallowed_press() const { return holds_press_; }
  // True until the physical trigger-up is observed, including after cancel.
  bool trigger_down() const { return trigger_down_; }
  // The point the wheel is anchored to.
  double anchor_x() const { return anchor_x_; }
  double anchor_y() const { return anchor_y_; }

 private:
  Config config_;
  Phase phase_ = Phase::Idle;
  MouseButton pressed_ = MouseButton::None;
  // Set when this process consumed the press, so the release must be consumed
  // with it. When false the release is replayed instead.
  bool holds_press_ = false;
  bool trigger_down_ = false;
  double anchor_x_ = 0.0;
  double anchor_y_ = 0.0;
  uint64_t last_input_ms_ = 0;
};

// Which sector of the wheel a point falls in, or -1 inside the dead zone.
//
// `hysteresis_deg` widens every boundary by that many degrees on the side the
// previous pick was on, so a cursor resting near a seam does not flicker between
// two slices. `previous` is the last non-negative answer, or -1 for none.
int sector_for(double dx, double dy, double dead_zone, double hysteresis_deg, int previous);

// Whether a keystroke is the trigger chord.
//
// Both halves have to agree: the key code, and every modifier the chord named.
// A key-code-only test is what makes a global hotkey hostile to the rest of the
// machine — with one, binding Control+Option+Space swallows the space bar in every
// application, because the key code cannot tell a bare Space from the chord.
//
// Superfluous modifiers are tolerated on purpose. Caps Lock is a flag on the event
// like any other, so demanding an exact flag match would stop the wheel working the
// moment Caps Lock was on, with nothing on screen to explain why.
//
// Pure so it can be tested without a running event tap, like `sector_for`.
bool chord_matches(const Config& config, uint16_t keycode, uint32_t flags);

// How many slices the wheel is divided into.
constexpr int kSectorCount = 8;

}  // namespace dsh

#endif  // DSH_QUICK_HELP_DECISION_H
