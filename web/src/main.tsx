import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Gate } from './components/SignIn.tsx';
import './styles.css';
// Last, so the design tokens win over any older value of the same variable.
import './theme/tokens.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Gate />
  </StrictMode>,
);
