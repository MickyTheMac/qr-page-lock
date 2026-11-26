// Stand-in for next/link in the single-file build: routes with the URL hash.
import type { AnchorHTMLAttributes, ReactNode } from "react";

export function toHash(href: string) {
  const name = href.replace(/^\/+|\/+$/g, "");
  return name ? `#${name}` : "#home";
}

export default function Link({ href, children, ...rest }: { href: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a href={toHash(href)} {...rest}>
      {children}
    </a>
  );
}
