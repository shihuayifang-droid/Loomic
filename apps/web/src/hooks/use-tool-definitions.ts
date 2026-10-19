"use client";

import { useEffect, useState } from "react";

import type { ToolDefinition } from "@loomic/shared";

import { useToast } from "@/components/toast";
import { errorCodeOf, lookupError } from "@/lib/error-catalog";
import { fetchToolDefinitions } from "@/lib/server-api";

/**
 * ED-00k · 逐图工具条的工具定义（工单 30F T1）
 *
 * 工具清单只从 `GET /api/tools` 读，前端不硬编码（X-P11）；这张表同时喂给工具条
 * （ED-00）、「更多」菜单（ED-00f）和 tooltip，所以取数只做一次、放在这里。
 *
 * ## 为什么缓存放在模块级
 *
 * 同一个 `accessToken` 只请求一次（工单 T1 的明文要求）。工具条、更多菜单、“编辑栏是不是
 * 该显示某个按钮”都会各自调这个 hook，请求次数不能跟着渲染次数走。缓存键是 token，
 * 因而是「每个会话一次」，token 换了（重新登录）就自然重取。
 *
 * **失败也留在缓存里**：`/api/tools` 是静态配置表，同一次会话里重试只会得到同一个结果，
 * 而每次重试都会再弹一次 toast；宁可让错误状态稳定，也不要让 toast 反复刷屏。
 */

export type ToolDefinitionsStatus = "loading" | "ready" | "error";

export type ToolDefinitionsState = {
  status: ToolDefinitionsStatus;
  /** `ready` 之外一律是空数组：调用方不需要再判 status 才敢 map。 */
  tools: ToolDefinition[];
};

const LOADING_STATE: ToolDefinitionsState = { status: "loading", tools: [] };
const ERROR_STATE: ToolDefinitionsState = { status: "error", tools: [] };

/** token → 请求。模块级缓存，见文件头注释。 */
const requestsByToken = new Map<string, Promise<ToolDefinition[]>>();

function requestToolDefinitions(accessToken: string): Promise<ToolDefinition[]> {
  const cached = requestsByToken.get(accessToken);
  if (cached !== undefined) return cached;

  const pending = fetchToolDefinitions(accessToken);
  requestsByToken.set(accessToken, pending);
  return pending;
}

export function useToolDefinitions(
  accessToken: string | null | undefined,
): ToolDefinitionsState {
  const { error: showError } = useToast();
  const [state, setState] = useState<ToolDefinitionsState>(LOADING_STATE);

  useEffect(() => {
    if (!accessToken) {
      // 没登录就没有工具条可言；把上一次 token 的 ready 状态收回到 loading。
      setState(LOADING_STATE);
      return;
    }

    let cancelled = false;
    setState((previous) => (previous.status === "loading" ? previous : LOADING_STATE));

    requestToolDefinitions(accessToken).then(
      (tools) => {
        if (cancelled) return;
        setState({ status: "ready", tools });
      },
      (error: unknown) => {
        if (cancelled) return;
        console.error("[tool-definitions] load failed:", error);
        setState(ERROR_STATE);
        // 文案只从目录取（X-40）：目录把未知 code 归到 `service`，就是这一条。
        showError(lookupError(errorCodeOf(error)).message);
      },
    );

    return () => {
      cancelled = true;
    };
  }, [accessToken, showError]);

  return state;
}
