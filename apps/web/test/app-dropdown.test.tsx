import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { AppDropdown, type AppDropdownItem } from "../src/components/ui/app-dropdown";

const TESTID = "agent-more";

// 本仓 vitest 没开 globals，RTL 不会自动 cleanup，每个文件自己收
afterEach(() => {
  cleanup();
});

function baseItems(): AppDropdownItem[] {
  return [
    { id: "first", label: "选项一", onSelect: vi.fn() },
    { id: "second", label: "选项二", onSelect: vi.fn() },
    {
      id: "locked",
      label: "未解锁项",
      onSelect: vi.fn(),
      disabled: true,
      disabledReason: "需要 Pro 权限",
    },
  ];
}

describe("AppDropdown（ED-00b：下拉一律 click 展开）", () => {
  it("验收1：hover 触发器时只出 tooltip，菜单不展开", async () => {
    render(
      <AppDropdown testid={TESTID} label="更多" tooltip="hover 只出这个" items={baseItems()} />,
    );
    const trigger = screen.getByTestId(TESTID);
    expect(screen.queryByTestId(`${TESTID}-menu`)).toBeNull();

    await userEvent.hover(trigger);

    await waitFor(() => expect(screen.getByText("hover 只出这个")).toBeInTheDocument());
    expect(screen.queryByTestId(`${TESTID}-menu`)).toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("触发器带 aria-haspopup=menu；click 展开", async () => {
    render(<AppDropdown testid={TESTID} label="更多" items={baseItems()} />);
    const trigger = screen.getByTestId(TESTID);
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(trigger);

    expect(await screen.findByTestId(`${TESTID}-menu`)).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("验收2：Tab 聚焦后按 Enter 展开，按 Esc 收起", async () => {
    render(<AppDropdown testid={TESTID} label="更多" items={baseItems()} />);
    const trigger = screen.getByTestId(TESTID);

    await userEvent.tab();
    expect(trigger).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByTestId(`${TESTID}-menu`)).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId(`${TESTID}-menu`)).toBeNull());
  });

  it("Space 也能展开", async () => {
    render(<AppDropdown testid={TESTID} label="更多" items={baseItems()} />);
    await userEvent.tab();
    await userEvent.keyboard(" ");
    expect(await screen.findByTestId(`${TESTID}-menu`)).toBeInTheDocument();
  });

  it("点击外部收起", async () => {
    render(<AppDropdown testid={TESTID} label="更多" items={baseItems()} />);
    await userEvent.click(screen.getByTestId(TESTID));
    expect(await screen.findByTestId(`${TESTID}-menu`)).toBeInTheDocument();

    await userEvent.click(document.body);

    await waitFor(() => expect(screen.queryByTestId(`${TESTID}-menu`)).toBeNull());
  });

  it("验收3：aria-expanded 在 true / false 之间切换", async () => {
    render(<AppDropdown testid={TESTID} label="更多" items={baseItems()} />);
    const trigger = screen.getByTestId(TESTID);

    await userEvent.click(trigger);
    await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "true"));

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "false"));

    await userEvent.click(trigger);
    await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "true"));
  });

  it("选中某项后 onSelect 被调用 1 次，菜单收起", async () => {
    const items = baseItems();
    render(<AppDropdown testid={TESTID} label="更多" items={items} />);

    await userEvent.click(screen.getByTestId(TESTID));
    await userEvent.click(await screen.findByTestId(`${TESTID}-item-first`));

    expect(items[0]?.onSelect).toHaveBeenCalledTimes(1);
    expect(items[1]?.onSelect).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId(`${TESTID}-menu`)).toBeNull());
  });

  it("disabled 项点击无效，hover 时 tooltip 显示 disabledReason", async () => {
    const items = baseItems();
    render(<AppDropdown testid={TESTID} label="更多" items={items} />);

    await userEvent.click(screen.getByTestId(TESTID));
    const locked = await screen.findByTestId(`${TESTID}-item-locked`);

    await userEvent.click(locked);
    expect(items[2]?.onSelect).not.toHaveBeenCalled();
    // 点 disabled 项不收起菜单
    expect(screen.getByTestId(`${TESTID}-menu`)).toBeInTheDocument();

    await userEvent.hover(locked);
    await waitFor(() =>
      expect(screen.getByTestId(`${TESTID}-item-locked-reason`)).toHaveTextContent("需要 Pro 权限"),
    );
  });

  it("testid 约定：菜单为 {testid}-menu，菜单项为 {testid}-item-{id}", async () => {
    render(<AppDropdown testid={TESTID} label="更多" items={baseItems()} />);
    await userEvent.click(screen.getByTestId(TESTID));
    expect(await screen.findByTestId(`${TESTID}-menu`)).toBeInTheDocument();
    expect(screen.getByTestId(`${TESTID}-item-first`)).toBeInTheDocument();
    expect(screen.getByTestId(`${TESTID}-item-second`)).toBeInTheDocument();
    expect(screen.getByTestId(`${TESTID}-item-locked`)).toBeInTheDocument();
  });
});
