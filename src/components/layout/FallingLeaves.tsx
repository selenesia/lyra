import { useState } from "preact/hooks";
import "../../assets/styles/base/falling-leaves.css";

const DESKTOP_LEAF_COUNT = 24;
const COMPACT_LEAF_COUNT = 12;
const COMPACT_WIDTH = 700;
const LEAF_COLORS = [
  "#c2410c",
  "#d97706",
  "#b45309",
  "#a16207",
  "#9a3412",
  "#dc2626",
  "#ca8a04",
];

function between(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function createLeaf(index: number): string {
  const drop = between(11, 22);
  const turn = (Math.random() < 0.5 ? -1 : 1) * 360;
  return [
    `--leaf:${LEAF_COLORS[index % LEAF_COLORS.length]}`,
    `--x:${between(-4, 104).toFixed(1)}`,
    `--size:${between(14, 28).toFixed(1)}px`,
    `--drop:${drop.toFixed(2)}s`,
    `--drop-delay:${(-Math.random() * drop).toFixed(2)}s`,
    `--drift:${between(-30, 90).toFixed(0)}px`,
    `--sway:${between(14, 42).toFixed(1)}px`,
    `--sway-time:${between(1.8, 3.6).toFixed(2)}s`,
    `--sway-delay:${(-Math.random() * 3).toFixed(2)}s`,
    `--angle:${between(0, 360).toFixed(0)}deg`,
    `--turn:${turn}deg`,
    `--spin-time:${between(6, 14).toFixed(2)}s`,
    `--flip-time:${between(0.9, 2).toFixed(2)}s`,
    `--flip-delay:${(-Math.random() * 2).toFixed(2)}s`,
  ].join(";");
}

function createLeaves(): string[] {
  const count =
    window.innerWidth < COMPACT_WIDTH ? COMPACT_LEAF_COUNT : DESKTOP_LEAF_COUNT;
  return Array.from({ length: count }, (_, index) => createLeaf(index));
}

export default function FallingLeaves() {
  const [leaves] = useState(createLeaves);

  return (
    <div class="falling-leaves" aria-hidden="true">
      {leaves.map((style, index) => (
        <div key={index} class="falling-leaf" style={style}>
          <div class="falling-leaf-body" />
        </div>
      ))}
    </div>
  );
}
