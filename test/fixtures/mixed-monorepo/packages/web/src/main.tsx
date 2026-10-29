import { createRoot } from 'react-dom/client';
import { add } from '@acme/lib';
import { greet } from './legacy.js';

createRoot(document.getElementById('root')!).render(<p>{greet(String(add(1, 2)))}</p>);
