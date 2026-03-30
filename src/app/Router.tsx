import { createBrowserRouter, RouterProvider, Navigate } from 'react-router-dom'
import { AppShell } from '../components/layout/AppShell'
import { HomeView } from '../views/HomeView'
import { ExploreView } from '../views/ExploreView'
import { AskView } from '../views/AskView'
import { IngestView } from '../views/IngestView'
import { OrientView } from '../views/OrientView'
import { SkillsView } from '../views/SkillsView'
import { AnchorsView } from '../views/AnchorsView'
import OnboardingDemoPage from '../views/OnboardingDemoPage'

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
      { path: '/pipeline', element: <Navigate to="/ingest" replace /> },
      { path: '/orient', element: <OrientView /> },
      { path: '/skills', element: <SkillsView /> },
      { path: '/anchors', element: <AnchorsView /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
])

export function Router() {
  return <RouterProvider router={router} />
}
