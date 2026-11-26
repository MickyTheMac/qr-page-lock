"use client";
import { usePathname } from "next/navigation";
import { Section, SiteHeader } from "./SiteChrome";

export function NavBar() {
  const path = usePathname() ?? "/";
  const active: Section = path.startsWith("/create") ? "create" : path.startsWith("/sign") ? "sign" : path.startsWith("/verify") ? "verify" : "home";
  return <SiteHeader active={active} />;
}
