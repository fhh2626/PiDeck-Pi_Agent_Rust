import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 更新检查只允许设置页手动触发；禁用开关打开后不再有自动检测定时器，
// 且按钮在禁用时不得再显示 loading（检查状态未落定前仍会转圈）。
test("app update check can be disabled and still supports a manual button", () => {
  const appSource = readFileSync("src/renderer/src/App.tsx", "utf8");
  const devTabSource = readFileSync(
    "src/renderer/src/components/app/settings/DevTab.tsx",
    "utf8",
  );

  // 保留启动后的自动检测，但禁用开关打开后不得再跑。
  assert.match(appSource, /check\("auto"\)/);
  assert.match(appSource, /1000 \* 60 \* 60 \* 6/);
  assert.match(appSource, /if \(settings\.disableUpdateCheck\) return;/);

  // 手动按钮：禁用时 onClick 为空且 loading 不显示（检查可能仍在途，但 UI 不得转圈）。
  // 按钮位于开发设置 tab（DevTab，自 SettingsModal 拆分）；disableUpdateCheck 为局部快捷变量
  assert.match(
    devTabSource,
    /onClick=\{disableUpdateCheck \? undefined : props\.onCheckUpdate\}/,
  );
  assert.match(
    devTabSource,
    /loading=\{props\.updateChecking && !disableUpdateCheck\}/,
  );
  assert.match(devTabSource, /disabled=\{disableUpdateCheck\}/);
});
