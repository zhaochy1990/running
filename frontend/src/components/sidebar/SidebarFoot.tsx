import { type ReactNode } from 'react'

export default function SidebarFoot({ children }: { children: ReactNode }) {
  return (
    <div className="flex-shrink-0 border-t border-border-subtle p-2.5 flex flex-col gap-2">
      {children}
    </div>
  )
}
