import { render } from 'preact';
import { browserFilesApi } from '../../src/ui/files/browser-api';
import { FilesView } from '../../src/ui/files/FilesView';

const root = document.getElementById('app');
if (root) render(<FilesView api={browserFilesApi} />, root);
