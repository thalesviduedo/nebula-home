import {
  Camera, Cloud, Lightbulb, Plug, Radio, type LucideProps,
} from "lucide-react";

const MAP: Record<string, React.ComponentType<LucideProps>> = {
  bulb: Lightbulb,
  plug: Plug,
  ir: Radio,
  cam: Camera,
  cloud: Cloud,
};

export function DeviceIcon({ kind, ...props }: { kind: string } & LucideProps) {
  const Cmp = MAP[kind] ?? Cloud;
  return <Cmp className="size-4" {...props} />;
}
