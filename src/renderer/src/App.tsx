import { Scissors } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { SetupStatus, UpdateState } from '@shared/types'
import { call, useEvent } from './api'
import { WorkIndicator } from './components/WorkIndicator'
import { useWork } from './lib/work'
import { About } from './screens/About'
import { Home } from './screens/Home'
import { Review } from './screens/Review'
import { Setup } from './screens/Setup'

export type Route = { name: 'home' } | { name: 'review'; jobId: string } | { name: 'about' }

export function App(): ReactNode {
  const [route, setRoute] = useState<Route>({ name: 'home' })
  const [setup, setSetup] = useState<SetupStatus | null>(null)
  const [update, setUpdate] = useState<UpdateState>({ kind: 'idle' })
  const work = useWork()

  useEffect(() => {
    void call('setup:status').then(setSetup)
    void call('app:info').then((i) => setUpdate(i.update))
  }, [])
  useEvent('setup:status', setSetup)
  useEvent('app:update', setUpdate)

  const go = useCallback((r: Route) => setRoute(r), [])
  useEvent('jobs:focus', ({ jobId }) => go({ name: 'review', jobId }))

  let body: ReactNode
  if (route.name === 'about') body = <About update={update} />
  else if (!setup) body = null
  else if (!setup.ready) body = <Setup status={setup} />
  else if (route.name === 'review') body = <Review key={route.jobId} jobId={route.jobId} go={go} />
  else body = <Home go={go} work={work} />

  return (
    <div className="shell">
      <header className="titlebar">
        <div className="brand">
          <span className="brand-mark">
            <Scissors size={11} strokeWidth={2.5} />
          </span>
          CrapCut
        </div>
        <nav className="nav">
          <button type="button" className={route.name !== 'about' ? 'active' : ''} onClick={() => go({ name: 'home' })}>
            Clips
          </button>
          <button type="button" className={route.name === 'about' ? 'active' : ''} onClick={() => go({ name: 'about' })}>
            About
          </button>
        </nav>
        <div className="spacer" />
        {setup?.ready && <WorkIndicator work={work} go={go} />}
        {update.kind === 'ready' && (
          <button type="button" className="btn sm primary no-drag" onClick={() => void call('app:installUpdate')}>
            Restart to update
          </button>
        )}
      </header>
      <main className="content">{body}</main>
    </div>
  )
}
