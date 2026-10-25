// T0 placeholder entry; T2 replaces this with the in-car UI.
import { CAR } from '../shared/constants.js';

const picker = document.getElementById('site-picker');
const status = document.getElementById('status');

const sites = await fetch('/api/sites').then((r) => r.json());
picker.innerHTML = sites.map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
status.textContent = `${sites.length} site(s) · ${CAR.name}`;
