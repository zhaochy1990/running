import { useEffect, useState } from 'react'
import AMapLoader from '@amap/amap-jsapi-loader'

// Use loose typing — AMap's TS types aren't shipped with the loader.
// Treating it as `any` keeps the component code readable; we wrap usage
// inside `ActivityMap` and don't leak this type elsewhere.
type AMapNamespace = unknown

declare global {
  interface Window {
    _AMapSecurityConfig?: { securityJsCode: string }
  }
}

let cachedPromise: Promise<AMapNamespace> | null = null

function loadAMap(): Promise<AMapNamespace> {
  if (cachedPromise) return cachedPromise
  const key = import.meta.env.VITE_AMAP_KEY as string | undefined
  const securityCode = import.meta.env.VITE_AMAP_SECURITY_CODE as string | undefined
  if (!key || !securityCode) {
    return Promise.reject(new Error('VITE_AMAP_KEY / VITE_AMAP_SECURITY_CODE missing'))
  }
  // AMap 2.0 requires securityJsCode on window. Set BEFORE the loader runs.
  window._AMapSecurityConfig = { securityJsCode: securityCode }
  cachedPromise = AMapLoader.load({
    key,
    version: '2.0',
    plugins: ['AMap.Scale', 'AMap.ToolBar'],
  })
  return cachedPromise
}

export function useAMap(): { AMap: AMapNamespace | null; error: string | null } {
  const [state, setState] = useState<{ AMap: AMapNamespace | null; error: string | null }>({
    AMap: null,
    error: null,
  })
  useEffect(() => {
    let cancelled = false
    loadAMap()
      .then((AMap) => {
        if (!cancelled) setState({ AMap, error: null })
      })
      .catch((e) => {
        if (!cancelled) setState({ AMap: null, error: e instanceof Error ? e.message : String(e) })
      })
    return () => {
      cancelled = true
    }
  }, [])
  return state
}
