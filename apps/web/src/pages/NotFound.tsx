import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <main className="page">
      <h1 className="page-title">Page introuvable</h1>
      <p><Link to="/">Revenir au tableau de bord</Link></p>
    </main>
  );
}
