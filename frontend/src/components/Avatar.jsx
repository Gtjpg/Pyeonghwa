const AVATAR_COLORS = [
  "bg-teal-700",
  "bg-sky-700",
  "bg-emerald-700",
  "bg-indigo-700",
  "bg-cyan-700",
  "bg-rose-700",
];

export default function Avatar({
  name = "?",
  size = "h-12 w-12",
  text = "text-base",
}) {
  const color =
    AVATAR_COLORS[
      [...name].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) %
        AVATAR_COLORS.length
    ];

  return (
    <div
      className={`${size} ${text} ${color} flex shrink-0 items-center justify-center rounded-full font-semibold uppercase text-white`}
    >
      {name.charAt(0)}
    </div>
  );
}
