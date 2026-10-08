import ReactDOM from 'react-dom/client';
import { ReleasePanel } from './ReleasePanel';
import { useReleasePanel } from './ReleasePanelProvider';
import '../styles/index.css';
import './panel.css';
function App() {
  const taskId = new URL(location.href).searchParams.get('task') ?? '';
  const state = useReleasePanel(taskId);
  return <ReleasePanel {...state} />;
}
const root = document.getElementById('root');
if (root) ReactDOM.createRoot(root).render(<App />);
