import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import DeviceSimulator from './DeviceSimulator';
import './styles.css';
import './readability.css';
import './design-tokens.css';
import './workspace-surfaces.css';

const Page = window.location.pathname.replace(/\/+$/, '') === '/simulator' ? DeviceSimulator : App;

createRoot(document.getElementById('root')!).render(
  <StrictMode><Page /></StrictMode>,
);
