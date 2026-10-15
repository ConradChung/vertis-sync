import { TopBar } from '@/components/shell/TopBar'

export default function AppLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <TopBar />
      <main className="shell">{children}</main>
    </>
  )
}
