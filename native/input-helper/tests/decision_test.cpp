// Table-driven tests for the input state machine.
//
// These are the tests that matter most: a swallowed press whose release leaks
// through makes an application select text or click something the user never
// aimed at, and that failure is invisible until it happens to someone. So every
// case below asserts the pairing invariant explicitly, not just the phase.

#include <cmath>
#include <cstdio>
#include <cstring>

#include "../decision.h"

namespace {

int g_pass = 0;
int g_fail = 0;

void check(bool ok, const char* name) {
  if (ok) {
    ++g_pass;
  } else {
    ++g_fail;
    std::printf("FAIL  %s\n", name);
  }
}

dsh::Config press_config() {
  dsh::Config config;
  config.trigger_vk = 58;  // Left Option on macOS.
  config.hold_mode = false;
  config.drag_threshold = 12.0;
  config.watchdog_ms = 10000;
  config.enabled = true;
  return config;
}

dsh::Config hold_config() {
  dsh::Config config = press_config();
  config.hold_mode = true;
  return config;
}

void test_press_mode_opens_and_closes() {
  dsh::DecisionState state;
  state.configure(press_config());
  state.on_trigger_down(100.0, 100.0);
  check(state.phase() == dsh::Phase::Wheel, "press 模式：快捷键按下立即打开轮盘");
  state.on_trigger_up();
  check(state.phase() == dsh::Phase::Wheel, "press 模式：松开快捷键后仍等待选择");
  state.on_mouse_down(100.0, 100.0, dsh::MouseButton::Left);
  check(state.phase() == dsh::Phase::Wheel, "press 模式：确认点击前保持轮盘");
  check(state.holds_swallowed_press(), "press 模式：按下被吞掉");

  state.on_mouse_move(140.0, 100.0);
  state.on_mouse_up(140.0, 100.0, dsh::MouseButton::Left);
  check(state.phase() == dsh::Phase::Idle, "press 模式：松开后回到空闲");
  check(!state.holds_swallowed_press(), "press 模式：松开也被吞掉（配对完整）");
}

void test_key_repeat_does_not_reopen() {
  dsh::DecisionState state;
  state.configure(press_config());
  state.on_trigger_down();
  state.on_trigger_down();  // Key repeat sends this many times.
  state.on_trigger_down();
  state.on_mouse_down(50.0, 50.0, dsh::MouseButton::Left);
  check(state.phase() == dsh::Phase::Wheel, "按键重复不会造成多个轮盘状态");
  state.on_mouse_up(50.0, 50.0, dsh::MouseButton::Left);
  // A second release must not replay anything.
  state.on_mouse_up(50.0, 50.0, dsh::MouseButton::Left);
  check(!state.holds_swallowed_press(), "多余的松开事件不会留下吞掉状态");
}

void test_hold_mode_requires_movement() {
  dsh::DecisionState state;
  state.configure(hold_config());
  state.on_trigger_down(200.0, 200.0);
  check(state.phase() == dsh::Phase::Pending, "按住模式：按下后先进入待定");

  state.on_mouse_move(203.0, 200.0);  // Below the threshold.
  check(state.phase() == dsh::Phase::Pending, "按住模式：未过阈值不打开轮盘");

  state.on_mouse_move(220.0, 200.0);  // Past the threshold.
  check(state.phase() == dsh::Phase::Wheel, "按住模式：越过阈值后打开轮盘");
}

void test_hold_mode_mouse_buttons_pass_through() {
  dsh::DecisionState state;
  state.configure(hold_config());
  state.on_trigger_down();
  state.on_mouse_down(10.0, 10.0, dsh::MouseButton::Left);
  state.on_mouse_up(10.0, 10.0, dsh::MouseButton::Left);
  check(!state.holds_swallowed_press(), "按住模式：鼠标按下与松开从不被截获");
  check(state.phase() == dsh::Phase::Pending, "按住模式：鼠标点击不改变键盘待定状态");
  state.on_trigger_up();
  check(state.phase() == dsh::Phase::Idle, "短触发键回到空闲");
}

void test_right_click_cancels() {
  dsh::DecisionState state;
  state.configure(press_config());
  state.on_trigger_down();
  state.on_mouse_down(80.0, 80.0, dsh::MouseButton::Left);
  check(state.phase() == dsh::Phase::Wheel, "右键取消：轮盘已打开");
  state.on_mouse_down(80.0, 80.0, dsh::MouseButton::Right);
  check(state.phase() == dsh::Phase::Idle, "右键取消：轮盘关闭");
  check(!state.holds_swallowed_press(), "右键取消：不留下吞掉的按下");
}

void test_escape_cancels() {
  dsh::DecisionState state;
  state.configure(press_config());
  state.on_trigger_down();
  state.on_mouse_down(80.0, 80.0, dsh::MouseButton::Left);
  state.on_escape();
  check(state.phase() == dsh::Phase::Idle, "Escape：轮盘关闭");
  check(!state.holds_swallowed_press(), "Escape：不留下吞掉的按下");
}

void test_escape_requires_physical_trigger_up_before_rearming() {
  dsh::DecisionState state;
  state.configure(hold_config());
  state.on_trigger_down(80.0, 80.0);
  state.on_mouse_move(110.0, 80.0);
  check(state.phase() == dsh::Phase::Wheel, "Esc锁：首次移动已打开轮盘");
  state.on_escape();
  check(state.phase() == dsh::Phase::Idle, "Esc锁：取消后回到空闲");
  check(state.trigger_down(), "Esc锁：物理空格未松开时仍保持锁定");
  state.on_trigger_down(80.0, 80.0);
  state.on_mouse_move(110.0, 80.0);
  check(state.phase() == dsh::Phase::Idle, "Esc锁：按住期间自动重复与移动不能再次打开");
  state.on_trigger_up();
  check(!state.trigger_down(), "Esc锁：真实松键清除锁定");
  state.on_trigger_down(80.0, 80.0);
  state.on_mouse_move(110.0, 80.0);
  check(state.phase() == dsh::Phase::Wheel, "Esc锁：松键后下一次手势可以打开");
}

void test_watchdog_requires_trigger_up_before_rearming() {
  dsh::DecisionState state;
  dsh::Config config = hold_config();
  config.watchdog_ms = 1000;
  state.configure(config);
  state.on_trigger_down(80.0, 80.0);
  state.on_tick(2000);
  check(state.phase() == dsh::Phase::Idle, "看门狗锁：超时回到空闲");
  check(state.trigger_down(), "看门狗锁：仍等物理松键");
  state.on_trigger_down(80.0, 80.0);
  state.on_mouse_move(110.0, 80.0);
  check(state.phase() == dsh::Phase::Idle, "看门狗锁：长按重复不能重新打开");
  state.on_trigger_up();
  state.on_trigger_down(80.0, 80.0);
  state.on_mouse_move(110.0, 80.0);
  check(state.phase() == dsh::Phase::Wheel, "看门狗锁：松键后下一次手势可打开");
}

void test_trigger_released_mid_wheel_cancels() {
  dsh::DecisionState state;
  state.configure(hold_config());
  state.on_trigger_down(80.0, 80.0);
  state.on_mouse_move(110.0, 80.0);
  check(state.phase() == dsh::Phase::Wheel, "按住+移动：阈值后显示轮盘");
  state.on_trigger_up();
  check(state.phase() == dsh::Phase::Idle, "松开触发键：轮盘完成确认");
}

void test_watchdog_releases_everything() {
  dsh::DecisionState state;
  dsh::Config config = press_config();
  config.watchdog_ms = 1000;
  state.configure(config);
  state.on_trigger_down();
  state.on_mouse_down(80.0, 80.0, dsh::MouseButton::Left);
  check(state.holds_swallowed_press(), "看门狗：吞掉了按下");
  const dsh::Decision decision = state.on_tick(5000);
  check(decision.cancel, "看门狗：发出取消");
  check(!state.holds_swallowed_press(), "看门狗：释放吞掉的按下，不留卡键");
  check(state.phase() == dsh::Phase::Idle, "看门狗：回到空闲");
}

void test_disable_mid_gesture_releases() {
  dsh::DecisionState state;
  state.configure(press_config());
  state.on_trigger_down();
  state.on_mouse_down(80.0, 80.0, dsh::MouseButton::Left);
  check(state.holds_swallowed_press(), "停用前：吞掉了按下");
  dsh::Config off = press_config();
  off.enabled = false;
  state.configure(off);
  check(!state.holds_swallowed_press(), "停用时：立即释放吞掉的按下");
  check(state.phase() == dsh::Phase::Idle, "停用时：回到空闲");
}

void test_disabled_passes_everything() {
  dsh::DecisionState state;
  dsh::Config off = press_config();
  off.enabled = false;
  state.configure(off);
  state.on_trigger_down();
  state.on_mouse_down(80.0, 80.0, dsh::MouseButton::Left);
  check(state.phase() == dsh::Phase::Idle, "停用状态：点击照常通过");
  check(!state.holds_swallowed_press(), "停用状态：不吞掉任何事件");
}

void test_sectors() {
  const double dead = 86.0;
  const double hys = 4.0;
  // Dead zone.
  check(dsh::sector_for(10.0, 0.0, dead, hys, -1) == -1, "中心死区不选中任何扇区");
  check(dsh::sector_for(0.0, 80.0, dead, hys, -1) == -1, "中心死区（正上方）不选中");
  // Cardinal directions: north is sector 0, clockwise from there.
  check(dsh::sector_for(0.0, -150.0, dead, hys, -1) == 0, "正北是第 0 扇区");
  check(dsh::sector_for(150.0, 0.0, dead, hys, -1) == 2, "正东是第 2 扇区");
  check(dsh::sector_for(0.0, 150.0, dead, hys, -1) == 4, "正南是第 4 扇区");
  check(dsh::sector_for(-150.0, 0.0, dead, hys, -1) == 6, "正西是第 6 扇区");
  // Diagonals.
  check(dsh::sector_for(106.0, -106.0, dead, hys, -1) == 1, "东北是第 1 扇区");
  // Angle wrap: just east of north is still sector 0, not 7.
  check(dsh::sector_for(10.0, -150.0, dead, hys, -1) == 0, "跨过 0 度不环绕到第 7 扇区");
}

void test_sector_hysteresis() {
  const double dead = 86.0;
  const double hys = 6.0;
  // A point just past the boundary between sector 0 and sector 1 (22.5 degrees).
  const double angle = 24.0 * M_PI / 180.0;
  const double x = std::sin(angle) * 150.0;
  const double y = -std::cos(angle) * 150.0;
  const int first = dsh::sector_for(x, y, dead, hys, -1);
  check(first == 1, "扇区边界：首次落在第 1 扇区");
  // Moving a hair back across the seam must not flip, because sector 1 is the
  // previous pick and the band is widened toward it.
  const int held = dsh::sector_for(x * 0.995, y * 0.995, dead, hys, first);
  check(held == first, "扇区边界：轻微抖动不会跳变");
  // Moving well past keeps moving on.
  const double far = 40.0 * M_PI / 180.0;
  const int moved = dsh::sector_for(std::sin(far) * 150.0, -std::cos(far) * 150.0, dead, hys, first);
  check(moved == 1, "扇区边界：明显移动仍留在第 1 扇区");
}

/**
 * The chord test, which is what keeps a global hotkey from eating the keyboard.
 *
 * `kFlagShift` and friends are spelled out here as raw bits rather than included
 * from the Apple headers: the point is that the *host* supplies these numbers, so
 * the helper only ever compares against them, and the test should fail if the
 * host's values ever drift from what the OS actually sets.
 */
void test_chord_matching() {
  constexpr uint32_t kShift = 1u << 17;
  constexpr uint32_t kControl = 1u << 18;
  constexpr uint32_t kOption = 1u << 19;
  constexpr uint32_t kCommand = 1u << 20;
  constexpr uint32_t kCapsLock = 1u << 16;

  dsh::Config config;
  config.trigger_vk = 49;  // Space
  config.modifier_mask = kControl | kOption;

  // The chord itself.
  check(dsh::chord_matches(config, 49, kControl | kOption), "组合键：命中 Control+Option+Space");
  // The one that matters: a bare Space is the user typing, not the wheel. Before
  // this check existed the helper swallowed every Space in every application.
  check(!dsh::chord_matches(config, 49, 0), "组合键：裸空格必须放行");
  check(!dsh::chord_matches(config, 49, kControl), "组合键：只按下一半修饰键不算命中");
  check(!dsh::chord_matches(config, 49, kOption), "组合键：只按下另一半也不算命中");
  // A different key with the right modifiers is not the chord either.
  check(!dsh::chord_matches(config, 0, kControl | kOption), "组合键：修饰键对但键不对");

  // Caps Lock must not break the wheel: it is a flag like any other, and an exact
  // match would have made the hotkey die with nothing on screen to explain it.
  check(dsh::chord_matches(config, 49, kControl | kOption | kCapsLock),
        "组合键：开着大写锁定仍能命中");
  check(dsh::chord_matches(config, 49, kControl | kOption | kShift | kCommand),
        "组合键：多按了其他修饰键仍能命中");

  // No modifiers configured means a bare key really is the trigger.
  dsh::Config bare;
  bare.trigger_vk = 49;
  bare.modifier_mask = 0;
  check(dsh::chord_matches(bare, 49, 0), "裸空格：没有修饰键时进入短暂手势待定");
  check(!dsh::chord_matches(bare, 49, kCommand), "裸空格：Command+Space 原样放行");
  check(!dsh::chord_matches(bare, 49, kControl), "裸空格：Control+Space 原样放行");
  check(!dsh::chord_matches(bare, 49, kOption), "裸空格：Option+Space 原样放行");
  check(!dsh::chord_matches(bare, 49, kShift), "裸空格：Shift+Space 原样放行");

  // A config that never arrived must match nothing, rather than matching the key
  // whose code happens to be zero.
  dsh::Config unset;
  unset.trigger_vk = 0;
  unset.modifier_mask = 0;
  check(!dsh::chord_matches(unset, 0, 0), "组合键：未配置时什么都不匹配");

  dsh::Config paused = config;
  paused.enabled = false;
  check(!dsh::chord_matches(paused, 49, kControl | kOption), "暂停后组合键原样放行");

  dsh::Config control_only;
  control_only.trigger_vk = 59;
  control_only.modifier_mask = 0;
  control_only.hold_mode = true;
  check(dsh::control_only(control_only), "Control单键使用专用flagsChanged路径");
  check(!dsh::chord_matches(control_only, 59, kControl), "Control单键不从普通KeyDown误触发");
  check(!dsh::chord_matches(control_only, 62, kControl), "右Control不从普通KeyDown误触发");
  check(!dsh::chord_matches(control_only, 8, kControl), "Control+C原样放行");
}

}  // namespace

int main() {
  test_press_mode_opens_and_closes();
  test_key_repeat_does_not_reopen();
  test_hold_mode_requires_movement();
  test_hold_mode_mouse_buttons_pass_through();
  test_right_click_cancels();
  test_escape_cancels();
  test_escape_requires_physical_trigger_up_before_rearming();
  test_watchdog_requires_trigger_up_before_rearming();
  test_trigger_released_mid_wheel_cancels();
  test_watchdog_releases_everything();
  test_disable_mid_gesture_releases();
  test_disabled_passes_everything();
  test_sectors();
  test_sector_hysteresis();
  test_chord_matching();

  std::printf("\n%d 项通过，%d 项失败。\n", g_pass, g_fail);
  return g_fail == 0 ? 0 : 1;
}
