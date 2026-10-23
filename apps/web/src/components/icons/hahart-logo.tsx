import type { SVGProps } from "react";

/**
 * HaHart brand logo — rounded lime square with a black H and a dot.
 *
 * The lime block (`#E4F23A`) is a fixed brand colour and is clear on both
 * light and dark backgrounds, so it is **not** inverted with the theme.
 *
 * @example
 * <HaHartLogo className="size-7" />
 */
export function HaHartLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {/* Rounded lime tile */}
      <rect width="64" height="64" rx="14" fill="#E4F23A" />
      {/* Letter H */}
      <path
        d="M18 16 h7 v13 h14 v-13 h7 v32 h-7 v-13 h-14 v13 h-7 z"
        fill="#111111"
      />
      {/* Dot */}
      <circle cx="46" cy="18" r="4.5" fill="#111111" />
    </svg>
  );
}

/**
 * Inverted variant for dark backgrounds — dark tile, lime H and dot.
 * Use this when the surface behind the logo is already dark (e.g. the auth
 * panel on the login page).
 */
export function HaHartLogoInverted(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {/* Dark tile */}
      <rect width="64" height="64" rx="14" fill="#111111" />
      {/* Letter H */}
      <path
        d="M18 16 h7 v13 h14 v-13 h7 v32 h-7 v-13 h-14 v13 h-7 z"
        fill="#E4F23A"
      />
      {/* Dot */}
      <circle cx="46" cy="18" r="4.5" fill="#E4F23A" />
    </svg>
  );
}
