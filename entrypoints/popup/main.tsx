import { render } from 'preact';
import '../../src/ui/theme.css';
import { FilesView } from '../../src/ui/FilesView';

const root = document.getElementById('app');
if (root) render(<FilesView surface="popup" />, root);
