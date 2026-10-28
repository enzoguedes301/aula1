import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import PainelAdmin from './components/PainelAdmin.tsx';
import './index.css';

/*
 * Entrada ENXUTA: este pacote é só o painel. No projeto de origem o main.tsx
 * decidia entre funil, painel, presente e sinais; aqui só existe o painel, e
 * ele é montado direto. A tela toda (paleta navy, CSS próprio no escopo `.adm`)
 * mora em components/PainelAdmin.tsx — ele não importa nada além do React.
 *
 * O painel fala com o backend pelo endereço de VITE_API_BASE_URL (ou `/api` na
 * mesma origem). Ver docs/CONECTAR-OFERTA-AO-PAINEL.md.
 */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PainelAdmin />
  </StrictMode>,
);
