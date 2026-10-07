import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Loading, RequireAdmin, RequireRead, RequireSession } from './components/Guards';
import Layout from './components/Layout';
import Login from './pages/Login';
import NotFound from './pages/NotFound';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const ChartPage = lazy(() => import('./pages/ChartPage'));
const History = lazy(() => import('./pages/History'));
const Method = lazy(() => import('./pages/Method'));
const Account = lazy(() => import('./pages/Account'));
const AdminLayout = lazy(() => import('./pages/admin/AdminLayout'));
const AdminQuadrimesters = lazy(() => import('./pages/admin/Quadrimesters'));
const AdminQuadrimesterEdit = lazy(() => import('./pages/admin/QuadrimesterEdit'));
const AdminParams = lazy(() => import('./pages/admin/Params'));
const AdminPrices = lazy(() => import('./pages/admin/Prices'));
const AdminReference = lazy(() => import('./pages/admin/Reference'));
const AdminBacktest = lazy(() => import('./pages/admin/Backtest'));
const AdminJournal = lazy(() => import('./pages/admin/Journal'));
const AdminAccess = lazy(() => import('./pages/admin/Access'));

export default function App() {
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="connexion" element={<Login />} />
          <Route element={<RequireRead />}>
            <Route index element={<Dashboard />} />
            <Route path="graphique" element={<ChartPage />} />
            <Route path="historique" element={<History />} />
            <Route path="methode" element={<Method />} />
          </Route>
          <Route path="compte" element={<RequireSession><Account /></RequireSession>} />
          <Route path="admin" element={<RequireAdmin><AdminLayout /></RequireAdmin>}>
            <Route index element={<Navigate to="quadrimestres" replace />} />
            <Route path="quadrimestres" element={<AdminQuadrimesters />} />
            <Route path="quadrimestres/:code" element={<AdminQuadrimesterEdit />} />
            <Route path="parametres" element={<AdminParams />} />
            <Route path="cours" element={<AdminPrices />} />
            <Route path="reference" element={<AdminReference />} />
            <Route path="backtest" element={<AdminBacktest />} />
            <Route path="journal" element={<AdminJournal />} />
            <Route path="acces" element={<AdminAccess />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
