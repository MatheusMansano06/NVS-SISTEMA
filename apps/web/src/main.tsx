import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/base.css';
import { applyTheme } from './shared/theme';

applyTheme(); // antes do primeiro desenho: quem escolheu o escuro não vê a tela piscar em branco

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
