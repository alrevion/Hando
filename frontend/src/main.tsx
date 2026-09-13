import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// WebKit применяет :active к нажатию ПАЛЬЦЕМ только если страница вообще
// слушает касания. Без этого пустого слушателя все кнопки на айфоне
// оставались «каменными»: продавливание работало в мыши и не работало там,
// где им пользуются. Дешевле, чем вешать touchstart на каждую кнопку.
document.addEventListener('touchstart', () => {}, { passive: true })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
