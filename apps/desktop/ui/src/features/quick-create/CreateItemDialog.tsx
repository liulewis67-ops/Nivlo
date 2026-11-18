import { useEffect, useRef } from "react";
import type { ComponentProps } from "react";
import { CreateConfiguration } from "./CreateConfiguration";

/** 主窗口中的弹窗名称、焦点来源与新增配置。 */
type CreateItemDialogProps = Omit<ComponentProps<typeof CreateConfiguration>, "embedded"> & {
  label: string;
  opener: HTMLElement | null;
};

/** 在主窗口承载新增表单，关闭后把焦点还给入口。 */
export function CreateItemDialog({ label, opener, ...configuration }: CreateItemDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    dialog.querySelector<HTMLInputElement>("[required]")?.focus();
    return () => {
      dialog.close();
      if (opener?.isConnected) opener.focus();
    };
  }, [opener]);

  return (
    <dialog
      ref={dialogRef}
      aria-modal="true"
      aria-label={label}
      className="fixed inset-0 m-auto h-[min(44rem,calc(100dvh-3rem))] w-[min(38rem,calc(100vw-2rem))] max-h-none max-w-none overflow-hidden rounded-xl border-0 bg-surface p-0 shadow-md backdrop:bg-black/30"
      onCancel={(event) => event.preventDefault()}
    >
      <CreateConfiguration embedded {...configuration} />
    </dialog>
  );
}
