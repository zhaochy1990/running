import { useEffect, useRef, useState } from 'react'

export function useReveal<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return
        e.target.classList.add('in')
        io.unobserve(e.target)
      })
    }, { threshold: 0.25 })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  return ref
}

export function useCountUp(
  target: number,
  opts: { suffix?: string; decimals?: number; start?: boolean } = {},
) {
  const { suffix = '', decimals = target % 1 !== 0 ? 1 : 0, start = true } = opts
  const [text, setText] = useState(`0${suffix}`)
  useEffect(() => {
    if (!start) return
    let raf = 0
    let begin = 0
    const dur = 1300
    const step = (t: number) => {
      if (!begin) begin = t
      const p = Math.min((t - begin) / dur, 1)
      const ease = 1 - Math.pow(1 - p, 3)
      setText(`${(target * ease).toFixed(decimals)}${suffix}`)
      if (p < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [target, suffix, decimals, start])
  return text
}
