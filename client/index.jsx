import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './app.css';

class ErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) return <main className="fatal"><h1>화면을 표시하지 못했습니다.</h1><p>저장된 데이터는 서버에 유지됩니다. 새로고침 후 다시 시도해 주세요.</p><pre>{this.state.error.message}</pre><button onClick={() => location.reload()}>새로고침</button></main>;
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(<ErrorBoundary><App /></ErrorBoundary>);
