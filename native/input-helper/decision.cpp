#include "decision.h"

#include <cmath>

namespace dsh {
namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kRadiansPerDegree = kPi / 180.0;

// Normalize an angle into [0, 2pi).
double normalize_angle(double radians) {
  while (radians < 0.0) radians += 2.0 * kPi;
  while (radians >= 2.0 * kPi) radians -= 2.0 * kPi;
  return radians;
}

// Degrees clockwise from north, which is how the wheel is laid out: the first
// slice sits above the anchor and the rest run clockwise.
double compass_degrees(double dx, double dy) {
  return normalize_angle(std::atan2(dx, -dy)) / kRadiansPerDegree;
}

}  // namespace

bool control_only(const Config& config) {
  return config.trigger_vk == 59 && config.modifier_mask == 0;
}

bool chord_matches(const Config& config, uint16_t keycode, uint32_t flags) {
  if (!config.enabled) return false;
  if (control_only(config)) return false; // flagsChanged owns both physical Control keys.
  // VK 0 is not a real key, so a config that never arrived matches nothing rather
  // than matching whatever key happens to have code zero.
  if (config.trigger_vk == 0) return false;
  if (keycode != config.trigger_vk) return false;
  if (config.trigger_vk == 49 && config.modifier_mask == 0) {
    constexpr uint32_t kTypingModifiers = (1u << 17) | (1u << 18) | (1u << 19) | (1u << 20);
    return (flags & kTypingModifiers) == 0;
  }
  // All required bits present, extras tolerated. See the header for why an exact
  // comparison would be worse.
  return (flags & config.modifier_mask) == config.modifier_mask;
}

int sector_for(double dx, double dy, double dead_zone, double hysteresis_deg, int previous) {
  const double distance = std::sqrt(dx * dx + dy * dy);
  // The centre is a cancel target, not a ninth slice, so a hand resting near the
  // middle never commits to an action by accident.
  if (distance < dead_zone) return -1;
  const double degrees = compass_degrees(dx, dy);
  const double slice = 360.0 / static_cast<double>(kSectorCount);
  int index = static_cast<int>((degrees + slice * 0.5) / slice) % kSectorCount;
  if (index < 0) index += kSectorCount;
  if (previous < 0 || hysteresis_deg <= 0.0) return index;

  // Stay on the current slice until the cursor has moved past its far boundary.
  // This is what stops a pointer sitting exactly on a seam from alternating.
  const double current_center = index * slice;
  double delta = degrees - current_center;
  while (delta > 180.0) delta -= 360.0;
  while (delta < -180.0) delta += 360.0;
  const double previous_center = previous * slice;
  double from_previous = degrees - previous_center;
  while (from_previous > 180.0) from_previous -= 360.0;
  while (from_previous < -180.0) from_previous += 360.0;
  // Only move on when the cursor is beyond the far edge in the new direction,
  // widened by the hysteresis band.
  const double band = slice * 0.5 + hysteresis_deg;
  if (std::fabs(delta) <= band && std::fabs(from_previous) <= band + slice) return previous;
  return index;
}

void DecisionState::configure(const Config& config) {
  const bool was_enabled = config_.enabled;
  const bool now_enabled = config.enabled;
  config_ = config;
  if (was_enabled && !now_enabled) {
    // Turning the wheel off mid-gesture must release everything: leaving the
    // trigger chord swallowed here is exactly the stuck-key case.
    phase_ = Phase::Idle;
    pressed_ = MouseButton::None;
    holds_press_ = false;
    trigger_down_ = false;
  }
}

void DecisionState::on_trigger_down(double x, double y) {
  if (!config_.enabled) return;
  // A repeated key-down from the OS key repeat must not open a second wheel.
  if (trigger_down_) return;
  trigger_down_ = true;
  anchor_x_ = x;
  anchor_y_ = y;
  phase_ = config_.hold_mode ? Phase::Pending : Phase::Wheel;
}

void DecisionState::on_trigger_up() {
  trigger_down_ = false;
  if (phase_ == Phase::Wheel) {
    // In hold mode the trigger release confirms at the current pointer. In
    // press mode it only arms the wheel for a later pointer click.
    if (config_.hold_mode) phase_ = Phase::Idle;
  } else if (phase_ == Phase::Pending) {
    phase_ = Phase::Idle;
  }
}

void DecisionState::on_other_modifier() {}

void DecisionState::on_mouse_down(double x, double y, MouseButton button) {
  if (!config_.enabled) return;
  // Hold gestures are keyboard + movement only. Mouse buttons remain paired
  // pass-through events, even when the wheel is visible.
  if (config_.hold_mode) return;
  // Only the left button starts a gesture. A right press cancels an open wheel
  // and otherwise belongs to the application underneath.
  if (button == MouseButton::Right) {
    if (phase_ == Phase::Wheel) {
      phase_ = Phase::Idle;
      holds_press_ = false;
      pressed_ = MouseButton::None;
      return;
    }
    return;
  }
  if (button != MouseButton::Left) return;
  if (phase_ == Phase::Wheel && !config_.hold_mode && !holds_press_) {
    anchor_x_ = x;
    anchor_y_ = y;
    pressed_ = MouseButton::Left;
    holds_press_ = true;
    return;
  }
  if (!trigger_down_) return;
  if (phase_ != Phase::Idle) return;

  anchor_x_ = x;
  anchor_y_ = y;
  pressed_ = MouseButton::Left;
  holds_press_ = true;
  if (config_.hold_mode) {
    // Press-and-hold: the wheel appears only once the hand actually moves, so
    // an ordinary Option+click still reaches the application.
    phase_ = Phase::Pending;
    return;
  }
  // Press-to-open: the chord alone is the trigger, and the press that followed
  // it must not reach the application.
  phase_ = Phase::Wheel;
}

void DecisionState::on_mouse_move(double x, double y) {
  // Movement is never swallowed. Swallowing it freezes the cursor for the user
  // and breaks the system's own drag state in the application underneath.
  if (phase_ == Phase::Pending) {
    const double dx = x - anchor_x_;
    const double dy = y - anchor_y_;
    if (std::sqrt(dx * dx + dy * dy) > config_.drag_threshold) phase_ = Phase::Wheel;
    return;
  }
}

void DecisionState::on_mouse_up(double x, double y, MouseButton button) {
  // The coordinates are unused here: the release is either swallowed or
  // replayed, and the replay is posted by the OS layer at the point it captured.
  (void)x;
  (void)y;
  if (config_.hold_mode) return;
  if (button != MouseButton::Left) return;
  if (!holds_press_) return;
  if (phase_ == Phase::Wheel) {
    // The release completes the gesture; the host decides what was selected.
    holds_press_ = false;
    pressed_ = MouseButton::None;
    phase_ = Phase::Idle;
    return;
  }
  // Pending or Idle with a press we consumed: give the click back untouched.
  holds_press_ = false;
  pressed_ = MouseButton::None;
  phase_ = Phase::Idle;
}

void DecisionState::on_escape() {
  if (phase_ == Phase::Idle) return;
  phase_ = Phase::Idle;
  holds_press_ = false;
  pressed_ = MouseButton::None;
}

Decision DecisionState::on_tick(uint64_t now_ms) {
  Decision decision;
  // A gesture the user walked away from must not stay armed: leaving a swallow
  // armed is how a keystroke disappears.
  if (phase_ == Phase::Idle) {
    last_input_ms_ = now_ms;
    return decision;
  }
  if (config_.watchdog_ms > 0 && now_ms - last_input_ms_ > config_.watchdog_ms) {
    const bool had_wheel = phase_ == Phase::Wheel;
    phase_ = Phase::Idle;
    const bool must_release = holds_press_;
    holds_press_ = false;
    pressed_ = MouseButton::None;
    last_input_ms_ = now_ms;
    decision.cancel = true;
    // The OS layer still has a swallowed press to account for; tell it to replay
    // the remainder so nothing is lost.
    if (must_release) decision.sink = Sink::Replay;
    (void)had_wheel;
    return decision;
  }
  return decision;
}

void DecisionState::reset() {
  phase_ = Phase::Idle;
  pressed_ = MouseButton::None;
  holds_press_ = false;
  trigger_down_ = false;
}

}  // namespace dsh
