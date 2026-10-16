// dsh-cost-strip — 客户端半边
//
// 注册进 conversation.composer.dock（输入框下方的 list 槽）：
//   一行小字显示「今日 ¥x.xx · 7 天 ¥y.yy」；鼠标悬浮弹出近 7 天柱状图；点击强制刷新。
// 注意：不要改用 conversation.composer.bar —— 那是输入框本体（single 槽，核心已注册，会冲突）。
window.__ModuleLoader__.load({
  id: "dsh-cost-strip",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const { useState, useEffect, useCallback, useRef } = react;
    const h = react.createElement;

    const DATA_ROUTE = "/dsh-cost-strip/data.json";
    const POLL_MS = 60 * 1000;

    // ---------------------------------------------------------- 格式化

    function money(value, currency) {
      if (value === null || value === undefined || !Number.isFinite(value)) return null;
      const symbol = !currency || currency === "CNY" ? "¥" : `${currency} `;
      const digits = Math.abs(value) >= 100 ? 1 : 2;
      return `${symbol}${value.toFixed(digits)}`;
    }

    function tokens(value) {
      if (!Number.isFinite(value) || value <= 0) return "0";
      if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
      if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
      if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
      return String(Math.round(value));
    }

    function shortDate(date) {
      // 2026-10-16 → 10/16
      return typeof date === "string" && date.length === 10 ? `${date.slice(5, 7)}/${date.slice(8, 10)}` : String(date ?? "");
    }

    // ------------------------------------------------------------ 组件

    function CostStrip() {
      const [data, setData] = useState(null);
      const [error, setError] = useState(null);
      const [open, setOpen] = useState(false);
      const [busy, setBusy] = useState(false);
      const mounted = useRef(true);

      const load = useCallback(async (force) => {
        if (force) setBusy(true);
        try {
          const res = await fetch(force ? `${DATA_ROUTE}?refresh=1` : DATA_ROUTE, { credentials: "same-origin" });
          const body = await res.json();
          if (!mounted.current) return;
          if (body && body.ok) {
            setData(body);
            setError(null);
          } else {
            setError((body && body.error) || "unknown");
          }
        } catch (err) {
          if (mounted.current) setError(String(err && err.message ? err.message : err));
        } finally {
          if (mounted.current && force) setBusy(false);
        }
      }, []);

      useEffect(() => {
        mounted.current = true;
        load(false);
        const timer = setInterval(() => load(false), POLL_MS);
        return () => {
          mounted.current = false;
          clearInterval(timer);
        };
      }, [load]);

      if (error) {
        return h("span", { style: { fontSize: 11, opacity: 0.6 } }, `消费数据不可用（${error}）`);
      }
      if (!data) {
        return h("span", { style: { fontSize: 11, opacity: 0.5 } }, "消费 …");
      }

      const currency = data.currency;
      const todayText = money(data.today && data.today.cost, currency);
      const totalText = money(data.total, currency);
      const todayTokens = data.today ? data.today.tokens : 0;

      // 没有价目时只报 token，并说明原因
      const main = todayText
        ? `今日 ${todayText}`
        : `今日 ${tokens(todayTokens)} tok`;
      const second = totalText && todayText ? ` · 7 天 ${totalText}` : "";
      const estimated = data.source === "session-log" ? "≈" : "";
      const days = Array.isArray(data.days) ? data.days : [];
      const maxCost = Math.max(...days.map((d) => (Number.isFinite(d.cost) ? d.cost : 0)), 0.0001);

      return h(
        "span",
        {
          style: { position: "relative", display: "inline-flex", alignItems: "center" },
          onMouseEnter: () => setOpen(true),
          onMouseLeave: () => setOpen(false)
        },
        h(
          "button",
          {
            type: "button",
            onClick: () => load(true),
            title: data.sourceNote || "",
            style: {
              fontSize: 11,
              lineHeight: "16px",
              padding: "0 6px",
              border: "none",
              background: "transparent",
              color: "inherit",
              opacity: busy ? 0.5 : 0.85,
              cursor: "pointer"
            }
          },
          `${main}${estimated}${second}`
        ),
        open
          ? h(
              "div",
              {
                style: {
                  position: "absolute",
                  bottom: "20px",
                  left: 0,
                  minWidth: 220,
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "1px solid var(--dsw-static-neutral-bluish-60, rgba(127,127,127,0.35))",
                  background: "var(--dsw-alias-bg-layer-1, rgba(28,28,30,0.96))",
                  color: "var(--dsw-alias-text-1, inherit)",
                  boxShadow: "0 8px 24px rgba(0,0,0,0.28)",
                  fontSize: 11,
                  zIndex: 40
                }
              },
              h("div", { style: { marginBottom: 6, opacity: 0.75 } }, `近 ${days.length} 天${currency ? `（${currency}）` : "（tokens）"}`),
              days.map((d) =>
                h(
                  "div",
                  { key: d.date, style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 2 } },
                  h("span", { style: { width: 40, opacity: 0.7 } }, shortDate(d.date)),
                  h(
                    "span",
                    { style: { display: "inline-block", height: 6, borderRadius: 3, background: "currentColor", opacity: 0.55, width: `${Math.max(2, Math.round(((Number.isFinite(d.cost) ? d.cost : 0) / maxCost) * 84))}px` } }
                  ),
                  h(
                    "span",
                    { style: { marginLeft: "auto" } },
                    Number.isFinite(d.cost) ? `${money(d.cost, currency)}` : `${tokens(d.tokens)} tok`
                  )
                )
              ),
              h("div", { style: { marginTop: 6, paddingTop: 6, borderTop: "1px solid rgba(127,127,127,0.25)", opacity: 0.75 } }, `${data.sourceNote || ""}${data.updatedAt ? ` · ${new Date(data.updatedAt).toLocaleTimeString()}` : ""}`),
              (data.notes || []).length
                ? h("div", { style: { marginTop: 4, opacity: 0.6 } }, (data.notes || []).join("；"))
                : null
            )
          : null
      );
    }

    // ------------------------------------------------------ 插件注册

    const inject = ["slots"];

    function apply(ctx) {
      ctx.slots.inject("conversation.composer.dock", () =>
        ctx.slots.register(
          {
            name: "conversation.composer.dock",
            id: "cost-strip",
            order: 95,
            label: "消费"
          },
          (props) => h(CostStrip, props)
        )
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
