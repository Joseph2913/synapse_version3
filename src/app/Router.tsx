import { lazy, Suspense } from 'react'
import { createBrowserRouter, RouterProvider, Navigate } from 'react-router-dom'
import { AppShell } from '../components/layout/AppShell'
import { HomeView } from '../views/HomeView'
import { ExploreView } from '../views/ExploreView'
import { AskView } from '../views/AskView'
import { IngestView } from '../views/IngestView'
import { OrientView } from '../views/OrientView'
import { SignalsView } from '../views/SignalsView'
import { CouncilOverviewView } from '../views/CouncilOverviewView'
import { AgentProfileView } from '../views/AgentProfileView'
import OnboardingDemoPage from '../views/OnboardingDemoPage'

const SourcesView = lazy(() => import('../views/SourcesView'))

const router = createBrowserRouter([
  // Standalone pages — no auth, no providers
  { path: '/onboarding', element: <OnboardingDemoPage /> },
  {
    element: <AppShell />,
    children: [
      { path: '/', element: <HomeView /> },
      { path: '/explore', element: <ExploreView /> },
      { path: '/ask', element: <AskView /> },
      { path: '/ingest', element: <IngestView /> },
      { path: '/capture', element: <Navigate to="/ingest" replace /> },
      { path: '/automate', element: <Navigate to="/ingest" replace /> },
      { path: '/sources', element: <Suspense fallback={null}><SourcesView /></Suspense> },
      { path: '/pipeline', element: <Navigate to="/sources" replace /> },
      { path: '/orient', element: <OrientView /> },
      { path: '/signals', element: <SignalsView /> },
      { path: '/council', element: <CouncilOverviewView /> },
      { path: '/council/:agentId', element: <AgentProfileView /> },
      { path: '/skills', element: <Navigate to="/signals?mode=skills" replace /> },
      { path: '/anchors', element: <Navigate to="/signals?mode=anchors" replace /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
])

export function Router() {
  return <RouterProvider router={router} />
}
