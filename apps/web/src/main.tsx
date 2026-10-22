import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startData } from './api/client';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App />);
void startData();
