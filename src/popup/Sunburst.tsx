// The Claude mark. The official Claude icon (static, LobeHub source) when idle
// so it doesn't move until you start recording, and the animated APNG spark
// while recording (it loops on its own).

export function Sunburst({ active, size = 44 }: { active: boolean; size?: number }) {
  const src = chrome.runtime.getURL(active ? 'spark/spark-live.png' : 'spark/claude-idle.svg')
  return (
    <img
      className="cc-spark"
      data-on={active}
      src={src}
      width={size}
      height={size}
      alt=""
      draggable={false}
    />
  )
}
