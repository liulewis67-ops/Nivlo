import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components";
import { ipc, isRunningInTauri } from "@/lib/ipc";
import type { UpdateInfoDto } from "@/lib/ipc";
import { reportError } from "@/lib/report-error";
import { useToastStore } from "@/stores/toast-store";

/** 启动后多久做一次静默的更新检查（毫秒）：不和启动抢资源。 */
const STARTUP_CHECK_DELAY_MS = 8000;

/**
 * 安装更新并重启：后端会先为当前数据做备份，再在后台下载、校验签名，并以静默模式安装
 * （`tauri.conf.json` 的 `plugins.updater.windows.installMode = "quiet"`：没有任何安装界面），装完自动重启。
 *
 * @param onError 失败时的处理（界面提示；当前版本保持不变）。
 */
function install(onError: (error: unknown) => void): void {
  ipc.installUpdate().catch(onError);
}

/**
 * 启动后静默检查一次更新；有新版本时弹出带「安装并重启」按钮的提示。检查失败（离线等）不打扰用户。
 */
export function useUpdateCheckOnStart(): void {
  const { t } = useTranslation();
  useEffect(() => {
    if (!isRunningInTauri()) return;
    const timer = window.setTimeout(() => {
      ipc
        .checkForUpdate()
        .then((update) => {
          if (update === null) return;
          useToastStore
            .getState()
            .push("info", t("settings.update.available", { version: update.version }), 30000, {
              label: t("settings.update.install"),
              onClick: () => {
                // 后台下载、静默安装（无安装界面），完成后自动重启；这里只告诉用户正在进行。
                useToastStore.getState().push("info", t("settings.update.installing"), 60000);
                install(reportError);
              },
            });
        })
        .catch(() => undefined);
    }, STARTUP_CHECK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [t]);
}

/**
 * 设置页的「检查更新」：手动检查、查看新版本说明、安装并重启。
 *
 * @returns 更新控件。
 */
export function UpdateSetting() {
  const { t } = useTranslation();
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "checking" }
    | { kind: "latest" }
    | { kind: "available"; update: UpdateInfoDto }
    | { kind: "installing" }
    | { kind: "error" }
  >({ kind: "idle" });

  /** 手动检查更新。 */
  function check(): void {
    setState({ kind: "checking" });
    ipc
      .checkForUpdate()
      .then((update) =>
        setState(update === null ? { kind: "latest" } : { kind: "available", update }),
      )
      .catch(() => setState({ kind: "error" }));
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        {state.kind === "available" && (
          <Button
            size="sm"
            onClick={() => {
              setState({ kind: "installing" });
              install(() => setState({ kind: "error" }));
            }}
          >
            {t("settings.update.install")}
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          disabled={state.kind === "checking" || state.kind === "installing"}
          onClick={check}
        >
          {t("settings.update.check")}
        </Button>
      </div>
      <p role="status" className="max-w-xs text-right text-xs text-muted">
        {state.kind === "checking" && t("settings.update.checking")}
        {state.kind === "latest" && t("settings.update.latest")}
        {state.kind === "available" &&
          t("settings.update.available", { version: state.update.version })}
        {state.kind === "installing" && t("settings.update.installing")}
        {state.kind === "error" && t("settings.update.error")}
      </p>
    </div>
  );
}
