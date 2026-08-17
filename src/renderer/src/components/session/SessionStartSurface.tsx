import { useState } from "react";
import {
  ArrowRight,
  Bug,
  CheckSquare,
  Code2,
  Lightbulb,
  ListChecks,
  Search,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { t, type TranslationKey } from "../../i18n";

/**
 * 新会话的工程入口：把空白时间线变成可编辑的任务选择器。
 * 快捷项使用完整 prompt 填入 composer，用户可以先调整内容，再自行确认发送。
 */
const QUICK_ACTIONS: ReadonlyArray<{
  icon: LucideIcon;
  title: TranslationKey;
  prompt: TranslationKey;
}> = [
  { icon: Search, title: "sessionStart.inspectTitle", prompt: "sessionStart.inspectPrompt" },
  { icon: ListChecks, title: "sessionStart.planTitle", prompt: "sessionStart.planPrompt" },
  { icon: Code2, title: "sessionStart.implementTitle", prompt: "sessionStart.implementPrompt" },
  { icon: Bug, title: "sessionStart.debugTitle", prompt: "sessionStart.debugPrompt" },
  { icon: CheckSquare, title: "sessionStart.testTitle", prompt: "sessionStart.testPrompt" },
  { icon: Sparkles, title: "sessionStart.reviewTitle", prompt: "sessionStart.reviewPrompt" },
];

/**
 * G 双栏杂志式起始页：左栏品牌叙述（衬线重音词标题 + 建议卡片沉底），
 * 右栏行动清单，中间一道竖发丝线分区；与项目空态（方案 B）同属章节式编辑排版语言。
 *
 * 注：左栏不放项目名——timeline 链路只透传 hasProject，项目名在侧栏/会话标题已可见，
 * 为一条装饰信息引入三跳 prop 透传不值得。
 */
export function SessionStartSurface(props: {
  /** 只把快捷 prompt 放入 composer，不自动发送；发送仍由用户控制。 */
  onQuickPrompt?: (prompt: string) => void;
}) {
  const [selectedPrompt, setSelectedPrompt] = useState<TranslationKey | null>(null);

  const insertPrompt = (promptKey: TranslationKey) => {
    if (!props.onQuickPrompt) return;
    props.onQuickPrompt(t(promptKey));
    setSelectedPrompt(promptKey);
  };

  return (
    <section className="session-start-surface flex min-h-full w-full items-center bg-transparent px-6 py-10">
      {/* 居中策略：items-center 几何居中后与空态页一样补 pt-[10vh] 下移，
          让标题/操作列表重心落到窗口光学中心（与 ProjectEmptyState 一致）。 */}
      <div className="mx-auto grid w-full max-w-4xl animate-in grid-cols-1 gap-10 pt-[10vh] duration-500 fade-in md:grid-cols-[1fr_1px_1fr]">
        {/* 左栏：品牌叙述；重音词固定拉丁词，保证内置 Plantin 斜体生效（同空态方案 B） */}
        <div className="flex animate-in flex-col duration-500 fade-in fill-mode-backwards slide-in-from-bottom-2">
          <h1 className="text-[clamp(2rem,3.5vw,2.75rem)] font-semibold leading-[1.12] tracking-[-0.03em] text-foreground">
            {t("sessionStart.titleLead")}<br />
            <span className="font-brand font-medium italic">{t("sessionStart.titleAccent")}</span>
            {/* 句号与空态页一致用前景色（黑/白实心）作为标题落点强调 */}
            <span className="text-foreground">{t("sessionStart.titlePunct")}</span>
          </h1>
          <p className="mt-5 max-w-sm text-[15px] leading-7 text-text-secondary">
            {t("sessionStart.subtitle")}
          </p>
          {/* 建议卡片沉底：仅桌面双栏可见；窄屏时由右栏底部文案承担 */}
          <div className="mt-auto hidden pt-10 md:block">
            <div className="rounded-xl border border-border-subtle bg-card p-4">
              <p className="flex items-start gap-2 text-[13px] leading-6 text-text-secondary">
                <Lightbulb className="mt-0.5 size-4 shrink-0 text-text-tertiary" aria-hidden="true" />
                {t("sessionStart.footer")}
              </p>
            </div>
          </div>
        </div>

        <span className="hidden w-px bg-border-subtle md:block" aria-hidden="true"></span>

        {/* 右栏：行动清单。发丝线分行而非卡片网格，prompt 全文收进 title 悬浮，
            保持栏内呼吸；hover 图标反色 + 箭头右移，与左栏的克制动效一致。 */}
        <div className="flex animate-in flex-col justify-center delay-100 duration-500 fade-in fill-mode-backwards slide-in-from-bottom-2">
          <p className="mb-3 text-xs font-medium text-text-tertiary">{t("sessionStart.quickActions")}</p>
          <div className="divide-y divide-border-subtle border-y border-border-subtle">
            {QUICK_ACTIONS.map((action) => {
              const Icon = action.icon;
              const selected = selectedPrompt === action.prompt;
              return (
                <button
                  key={action.prompt}
                  type="button"
                  disabled={!props.onQuickPrompt}
                  aria-pressed={selected}
                  title={t(action.prompt)}
                  className={`group flex w-full items-center gap-3 px-1 py-3.5 text-left transition-colors hover:bg-muted/60 disabled:opacity-50${selected ? " bg-muted/60" : ""}`}
                  onClick={() => insertPrompt(action.prompt)}
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground transition-colors group-hover:bg-foreground group-hover:text-background">
                    <Icon size={16} aria-hidden="true" />
                  </span>
                  <span className="flex-1 text-sm font-medium text-foreground">{t(action.title)}</span>
                  <ArrowRight
                    size={16}
                    className={`shrink-0 text-text-tertiary transition-all group-hover:translate-x-0.5 group-hover:text-foreground${selected ? " text-foreground" : ""}`}
                    aria-hidden="true"
                  />
                </button>
              );
            })}
          </div>
          <p className="mt-4 text-xs leading-5 text-text-tertiary md:hidden">{t("sessionStart.footer")}</p>
        </div>
      </div>
    </section>
  );
}
