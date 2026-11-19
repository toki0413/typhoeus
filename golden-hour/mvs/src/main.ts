import { createWorld } from './sim/world';
import { buildDebrief } from './eval/debrief';
import { createScene } from './render/scene';
import { createAgents } from './render/agents';
import { createSmoke } from './render/smoke';
import { createDoor } from './render/door';
import { createHud } from './ui/hud';
import { createDoorUi } from './ui/door';
import { createActions } from './ui/actions';
import { renderDebrief } from './ui/debrief';
import { beginRun, advance, restart } from './app/session';

const canvas = document.getElementById('app') as HTMLCanvasElement;
const hudRoot = document.getElementById('hud')!;
const doorRoot = document.getElementById('door-ui')!;
const actionsRoot = document.getElementById('actions')!;
const debriefRoot = document.getElementById('debrief')!;

const sim = createWorld('GH-FIRE-MVS');

const { scene, camera, renderer } = createScene();
renderer.setSize(window.innerWidth, window.innerHeight);
canvas.replaceWith(renderer.domElement);
renderer.domElement.id = 'app';

const agents = createAgents(scene);
const smoke = createSmoke(scene);
const doorMesh = createDoor(scene);
const hud = createHud(hudRoot);
const doorUi = createDoorUi(doorRoot, sim);
const actions = createActions(actionsRoot, sim);

window.addEventListener('resize', () => {
  const aspect = window.innerWidth / window.innerHeight;
  const frustum = 16;
  camera.left = -frustum * aspect;
  camera.right = frustum * aspect;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'Enter') beginRun(sim);
  if (import.meta.env.DEV && e.code === 'KeyT' && sim.phase === 'execute') {
    for (let i = 0; i < 600; i++) advance(sim, 1 / 20);
  }
});

const DT = 1 / 20;
let acc = 0;
let last = performance.now();
let hudTimer = 0;
let debriefShown = false;

function frame(now: number) {
  requestAnimationFrame(frame);
  const raw = Math.min((now - last) / 1000, 0.25);
  last = now;

  if (sim.phase === 'execute') {
    acc += raw;
    while (acc >= DT) {
      const result = advance(sim, DT);
      acc -= DT;
      if (result.enteredDebrief) break;
    }
  }

  if (sim.phase === 'debrief' && !debriefShown) {
    debriefRoot.style.display = 'block';
    renderDebrief(debriefRoot, buildDebrief(sim), () => {
      restart(sim);
      debriefRoot.style.display = 'none';
      debriefShown = false;
      acc = 0;
    });
    debriefShown = true;
  }

  agents.update(sim);
  smoke.update(sim);
  doorMesh.update(sim);
  doorUi.update(sim);
  actions.update(sim);
  hudTimer += raw;
  if (hudTimer >= 0.1) {
    hudTimer = 0;
    hud.update(sim);
  }
  renderer.render(scene, camera);
}

requestAnimationFrame(frame);
