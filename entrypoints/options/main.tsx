import { render } from 'preact';
import '../../src/ui/theme.css';
import './options.css';
import { App } from './App';

const root = document.getElementById('app');
if (root) render(<App />, root);
