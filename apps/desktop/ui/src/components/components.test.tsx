import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Button, Checkbox, Input, Menu, ToastViewport } from "@/components";
import { useToastStore } from "@/stores/toast-store";

describe("Button", () => {
  it("点击时触发 onClick，禁用时不触发", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<Button onClick={onClick}>保存</Button>);
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <Button onClick={onClick} disabled>
        保存
      </Button>,
    );
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("默认 type 为 button，不会意外提交表单", () => {
    render(<Button>普通</Button>);
    expect(screen.getByRole("button", { name: "普通" })).toHaveAttribute("type", "button");
  });
});

describe("Input", () => {
  it("通过 aria-label 获得可访问名称并响应输入", async () => {
    const user = userEvent.setup();
    render(<Input aria-label="标题" />);
    const input = screen.getByRole("textbox", { name: "标题" });
    await user.type(input, "你好");
    expect(input).toHaveValue("你好");
  });
});

describe("Checkbox", () => {
  /** 受控的复选框，用来验证状态流转。 */
  function Controlled() {
    const [checked, setChecked] = useState(false);
    return <Checkbox checked={checked} onCheckedChange={setChecked} label="已完成" />;
  }

  it("点击标签切换选中状态", async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    const box = screen.getByRole("checkbox", { name: "已完成" });
    expect(box).not.toBeChecked();
    await user.click(box);
    expect(box).toBeChecked();
  });

  it("可以用键盘空格切换", async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    await user.tab();
    await user.keyboard(" ");
    expect(screen.getByRole("checkbox", { name: "已完成" })).toBeChecked();
  });
});

describe("Menu", () => {
  it("打开后可以选择菜单项，并触发回调", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <Menu
        trigger={<Button>更多</Button>}
        items={[{ id: "rename", label: "重命名", onSelect }]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "更多" }));
    await user.click(await screen.findByRole("menuitem", { name: "重命名" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe("ToastViewport", () => {
  it("错误 Toast 使用 alert 角色，可手动关闭", async () => {
    const user = userEvent.setup();
    render(<ToastViewport />);
    act(() => {
      useToastStore.getState().push("error", "保存失败");
    });
    expect(screen.getByRole("alert")).toHaveTextContent("保存失败");
    await user.click(screen.getByRole("button", { name: "关闭提示" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("到时间后自动消失", () => {
    vi.useFakeTimers();
    try {
      render(<ToastViewport />);
      act(() => {
        useToastStore.getState().push("info", "已保存", 1000);
      });
      expect(screen.getByRole("status")).toHaveTextContent("已保存");
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
