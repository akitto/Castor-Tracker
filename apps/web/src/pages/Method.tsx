import { Link } from 'react-router-dom';
import { Loading } from '../components/Guards';
import { FIELD_LABEL, toEstimateParams, useActiveParams, useHistory, useLatestBacktest } from '../lib/data';
import { dateFr, euro, pct, stampShort } from '../lib/format';

interface VariantSummary {
  key: string;
  label: string;
  n: number;
  nExact: number;
  nMissing: number;
  exactRate: number;
  mae: number | null;
}
interface ReplayBucket {
  label: string;
  n: number;
  coverage: number | null;
  hitRate: number | null;
  meanReliability: number | null;
}

const ROUNDING: Record<string, string> = { nearest: 'au centime le plus proche', up: 'au centime supérieur', down: 'au centime inférieur' };

/** EF-30 : formule, indice de fiabilité, sources, limites et résultats du backtest. */
export default function Method() {
  const params = useActiveParams();
  const formula = useLatestBacktest('formula');
  const replay = useLatestBacktest('replay');
  const history = useHistory();
  if (params.isLoading) return <Loading />;
  const p = toEstimateParams(params.data);
  const factor = ((10_000 - p.discountBps) / 10_000).toLocaleString('fr-FR');
  const field = FIELD_LABEL[p.priceField] ?? { one: p.priceField, many: p.priceField };
  const fsum = formula.data?.summary as { variants?: VariantSummary[]; exact?: string | null; active?: string } | undefined;
  const rsum = replay.data?.summary as { coverage?: number | null; n?: number; buckets?: ReplayBucket[] } | undefined;
  const notices = (history.data ?? []).filter((h) => h.notice_url && h.official_price !== null);

  return (
    <main className="page">
      <div className="prose">
        <p className="eyebrow">Méthode</p>
        <h1 className="page-title">Comment le prix est estimé</h1>
        <p>
          Castor Tracker calcule, avant son annonce officielle, le prix de souscription Castor du quadrimestre suivant.
          Le prix découle d’une formule publique appliquée à des cours publics : il est calculable au centime dès que la
          date du conseil d’administration (CA) et les cours de la fenêtre sont connus, et estimable avant.
        </p>

        <h2>La formule</h2>
        <p className="formula">
          Prix = arrondi {ROUNDING[p.rounding]} de {factor} × moyenne des {field.many} des {p.windowDays} séances précédant le CA
        </p>
        <ul>
          <li>{field.many[0].toUpperCase() + field.many.slice(1)} : {p.priceField === 'open' ? 'premier cours coté de chaque séance, comme l’écrivent les avis publiés par VINCI à chaque quadrimestre' : 'variante retenue par le backtest'}.</li>
          <li>Séances : jours de cotation Euronext Paris ({p.excludeBoardDay ? 'jour du CA exclu' : 'jour du CA inclus'}). Les fermetures (1er janvier, Vendredi saint, lundi de Pâques, 1er mai, 25 et 26 décembre) sont sautées ; les séances courtes des 24 et 31 décembre comptent.</li>
          <li>Décote : {(p.discountBps / 100).toLocaleString('fr-FR')} %. Le calcul se fait en nombres exacts (jamais en flottants) avant l’arrondi final.</li>
          <li>Cours bruts, jamais ajustés des dividendes.</li>
        </ul>

        <h2>Le calendrier</h2>
        <p>
          Trois quadrimestres par an (janvier–avril, mai–août, septembre–décembre). Les versements ferment le 15 du dernier
          mois. Le CA qui fixe le prix se réunit deux à trois mois avant l’ouverture : mi-octobre pour /1, début février
          pour /2, juin pour /3. Le prix du quadrimestre suivant n’est plus annoncé qu’après la fermeture des versements du
          quadrimestre en cours : à ce moment-là, il est en général déjà figé, et la principale inconnue est la date exacte
          du CA.
        </p>

        <h2>L’estimation</h2>
        <ul>
          <li>Tant que la fenêtre n’est pas complète ou que la date du CA est incertaine, l’application simule les cours manquants : {p.nSims.toLocaleString('fr-FR')} tirages.</li>
          <li>Chaque tirage choisit une date de CA dans le créneau (selon les poids saisis, uniformes par défaut), puis rejoue au hasard des rendements quotidiens des {p.bootstrapDays} dernières séances, recentrés sur zéro : aucune tendance n’est supposée.</li>
          <li>Les dividendes détachés pendant la projection sont retirés du cours.</li>
          <li>Estimation centrale : la médiane des tirages. Intervalle à 90 % : du 5e au 95e centile.</li>
          {p.modelSigmaBps > 0 && <li>Erreur de modèle ajoutée : {(p.modelSigmaBps / 100).toLocaleString('fr-FR')} % (écart mesuré au backtest).</li>}
        </ul>

        <h2>L’indice de fiabilité (IF)</h2>
        <p>
          L’IF est la probabilité, selon le modèle, que le prix officiel tombe à ±{(p.toleranceBps / 100).toLocaleString('fr-FR')} % de
          l’estimation centrale. « IF 87 » se lit : 87 % de chances.
        </p>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th scope="col">IF</th><th scope="col">Libellé</th><th scope="col">Situation typique</th></tr></thead>
            <tbody>
              <tr><td className="mono">95–100</td><td>Quasi certain</td><td>15 séances connues ou plus, date du CA connue</td></tr>
              <tr><td className="mono">80–94</td><td>Fiable</td><td>13 ou 14 séances connues</td></tr>
              <tr><td className="mono">50–79</td><td>Indicatif</td><td>Fenêtre à mi-parcours</td></tr>
              <tr><td className="mono">0–49</td><td>Spéculatif</td><td>Fenêtre pas commencée, ou date du CA très floue</td></tr>
            </tbody>
          </table>
        </div>

        <h2>Sources des données</h2>
        <ul>
          <li>Cours VINCI (Euronext Paris, ISIN FR0000125486, mnémonique DG) : Yahoo Finance en source principale, Euronext Live en contrôle quotidien, import CSV en secours.</li>
          <li>Collecte : ouverture du jour vers 9 h 20, cours en séance toutes les 15 minutes (différé de 15 minutes), séance complète à 18 h, rattrapage chaque matin.</li>
          <li>Prix officiels et dates de CA : avis publiés par VINCI à chaque quadrimestre et règlements des FCPE Castor Relais.</li>
        </ul>
        {notices.length > 0 && (
          <ul>
            {notices.map((h) => (
              <li key={h.code}>
                <a href={h.notice_url as string} target="_blank" rel="noreferrer noopener">{h.code}</a> : {euro(Number(h.official_price))}
                {h.board_date ? `, CA du ${dateFr(h.board_date)}` : ''}
              </li>
            ))}
          </ul>
        )}

        <h2>Résultats du backtest</h2>
        {fsum?.variants?.length ? (
          <>
            <p>
              Dernier contrôle le {stampShort(formula.data?.run_at)} :{' '}
              {fsum.exact ? 'une variante retrouve tous les prix de référence au centime.' : 'aucune variante ne retrouve encore tous les prix au centime.'}
            </p>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th scope="col">Variante</th><th scope="col" className="num">Prix exacts</th><th scope="col" className="num">Écart moyen</th></tr></thead>
                <tbody>
                  {fsum.variants.slice(0, 6).map((v) => (
                    <tr key={v.key} className={v.key === fsum.active ? 'current' : undefined}>
                      <td>{v.label}{v.key === fsum.active ? ' (active)' : ''}</td>
                      <td className="num">{v.nExact}/{v.n}{v.nMissing ? ` (+${v.nMissing} sans données)` : ''}</td>
                      <td className="num">{v.mae === null ? '—' : euro(v.mae)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p className="muted">Backtest pas encore lancé.</p>
        )}
        {rsum?.buckets?.length ? (
          <>
            <p>
              Rejeu des estimations passées : le prix officiel tombe dans l’intervalle à 90 % dans{' '}
              <strong>{pct(rsum.coverage ?? null, 1, false)}</strong> des cas ({rsum.n} estimations rejouées, attendu : 80 à 98 %).
            </p>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th scope="col">Situation</th><th scope="col" className="num">Points</th><th scope="col" className="num">Dans l’intervalle</th><th scope="col" className="num">À ±1 %</th><th scope="col" className="num">IF moyen</th></tr></thead>
                <tbody>
                  {rsum.buckets.map((b) => (
                    <tr key={b.label}>
                      <td>{b.label}</td>
                      <td className="num">{b.n}</td>
                      <td className="num">{pct(b.coverage, 0, false)}</td>
                      <td className="num">{pct(b.hitRate, 0, false)}</td>
                      <td className="num">{b.meanReliability === null ? '—' : Math.round(b.meanReliability)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}

        <h2>Limites</h2>
        <ul>
          <li>Estimation non officielle : seul l’avis publié par VINCI fait foi.</li>
          <li>Une date de CA mal connue décale la fenêtre, donc le prix : l’IF en tient compte via le créneau.</li>
          <li>Les sources de cours gratuites peuvent comporter des erreurs ; un contrôle croisé et une alerte d’écart les signalent.</li>
          <li>Un changement des règles (décote, nombre de séances, calendrier) rend les estimations caduques jusqu’à la mise à jour des paramètres.</li>
          <li>Ce n’est pas un conseil en investissement.</li>
        </ul>
        <p className="small muted">
          Voir aussi l’<Link to="/historique">historique des quadrimestres</Link>.
          {params.data ? ` Paramètres « ${params.data.label} », actifs depuis le ${stampShort(params.data.valid_from)}.` : ''}
        </p>
      </div>
    </main>
  );
}
