import { createBrowserRouter, RouterProvider, Navigate } from 'react-router-dom'
import { AppShell } from '../components/layout/AppShell'
import { HomeView } from '../views/HomeView'
import { ExploreView } from '../views/ExploreView'
import { AskView } from '../views/AskView'
import { CaptureView } from '../views/CaptureView'
import { AutomateView } from '../views/AutomateView'
import { OrientView } from '../views/OrientView'
import { PipelineView } from '../views/PipelineView'
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
      { path: '/capture', element: <CaptureView /> },
      { path: '/ingest', element: <Navigate to="/capture" replace /> },
      { path: '/automate', element: <AutomateView /> },
      { path: '/orient', element: <OrientView /> },
      { path: '/pipeline', element: <PipelineView /> },
      { path: '/skills', element: <SkillsView /> },
      { path: '/anchors', element: <AnchorsView /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
])

export function Router() {
  return <RouterProvider router={router} />
}
