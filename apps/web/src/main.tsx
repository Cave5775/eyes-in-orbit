import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startData } from './api/client';
import '@fontsource-variable/archivo/wdth.css'; // weight and width axes, bundled so the app works offline
import './styles.css';

createRoot(document.getElementById('root')!).render(<App />);
void startData();
