import type { Skin } from "@/stores/skin-store";

/** 取自悬浮窗交互或待办的角色状态。 */
type RobotExpression = "idle" | "hover" | "grabbed" | "ready" | "done";
/** 与图片帧设置无关的内置角色外观。 */
type RobotAppearance = Pick<Skin, "robot" | "color" | "face">;

const PALETTES = {
  steel: ["#cbd4de", "#7590ae", "#83ceff"],
  mint: ["#b8f4dc", "#54b7a0", "#d2fff0"],
  amber: ["#ffd597", "#db8842", "#fff0be"],
  lilac: ["#e4d7ff", "#9a81d1", "#f9e9ff"],
  pearl: ["#f7f1df", "#b6ad96", "#fffbed"],
} as const;

const ORIGINAL_COLORS = { scout: "steel", relay: "amber", memo: "pearl" } as const;

/**
 * 用相同的几何部件渲染设置预览和桌面伙伴。
 * @param props 外形、配色、表情与当前交互状态。
 * @returns 透明背景的角色图形。
 */
export function RobotAvatar({
  appearance,
  expression = "idle",
}: {
  appearance: RobotAppearance;
  expression?: RobotExpression;
}) {
  const { robot, color, face } = appearance;
  const [shell, edge, light] = PALETTES[color === "original" ? ORIGINAL_COLORS[robot] : color];
  const ink = "#182a34";
  const signal = expression === "grabbed" || expression === "ready" ? "#ffe18d" : light;
  const narrow = face === "focused" ? 1.25 : 2.75;
  const lifted = expression === "hover" || expression === "grabbed";

  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 48 36"
      className="nv-robot pointer-events-none size-full"
      data-expression={expression}
      fill="none"
    >
      <path d="M15 30h18v3.5a1 1 0 0 1-1 1H16a1 1 0 0 1-1-1Z" fill={edge} stroke={ink} />
      <g className="nv-robot-head" strokeLinejoin="round">
        {robot === "scout" && (
          <>
            <path d="M25 11V7l5-3" stroke={ink} strokeWidth="1.8" strokeLinecap="round" />
            <circle cx="31" cy="3.5" r="2.4" fill={signal} stroke={ink} strokeWidth="1.2" />
            <path d="M10 16H6v10h4m28-10h4v10h-4" fill={edge} stroke={ink} strokeWidth="1.4" />
            <path
              d="M14 10h20l5 5v12l-5 5H14l-5-5V15Z"
              fill={shell}
              stroke={ink}
              strokeWidth="1.5"
            />
          </>
        )}
        {robot === "relay" && (
          <>
            <path
              d="M18 10V6h12v4M7 17h5v10H7zm29 0h5v10h-5z"
              fill={edge}
              stroke={ink}
              strokeWidth="1.5"
            />
            <path d="M11 13l4-4h18l4 4v17H11Z" fill={shell} stroke={ink} strokeWidth="1.5" />
            <path d="M14 29h20" stroke={edge} strokeWidth="2" />
          </>
        )}
        {robot === "memo" && (
          <>
            <path d="M15 11V5h10l5 5v4" fill={signal} stroke={ink} strokeWidth="1.5" />
            <path d="M25 5v5h5" stroke={ink} />
            <rect
              x="7.5"
              y="10"
              width="33"
              height="22"
              rx="9"
              fill={shell}
              stroke={ink}
              strokeWidth="1.5"
            />
          </>
        )}
        <rect
          x="12"
          y="14"
          width="24"
          height="14"
          rx={robot === "memo" ? 5 : 2.5}
          fill="#193749"
          stroke={ink}
          strokeWidth="1"
        />
        <g stroke={signal} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          {expression === "done" ? (
            <path d="m19.5 21 3 3 6-6" strokeWidth="2.2" />
          ) : expression === "ready" ? (
            <path d="M24 17v7m-3-3 3 3 3-3" />
          ) : (
            <>
              <path d={lifted ? "m16.5 22 2.5-3 2.5 3" : `M19 ${21 - narrow}v${narrow * 2}`} />
              <path
                d={
                  face === "playful" || lifted
                    ? "m26.5 22 2.5-3 2.5 3"
                    : `M29 ${21 - narrow}v${narrow * 2}`
                }
              />
              {face === "friendly" && <path d="M23 24h2" strokeWidth="1" />}
            </>
          )}
        </g>
      </g>
    </svg>
  );
}
