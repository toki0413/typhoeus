import { createWorld } from './sim/world';
import { stepSim } from './sim/step';
import { buildDebrief } from './eval/debrief';
import { createScene } from './render/scene';
import { createAgents } from './render/agents';
import { createSmoke } from './render/smoke';
import { createHud } from './ui/hud';
import { createDoorUi } from './ui/door';
import { renderDebrief } from './ui/debrief';

const canvas = document.getElementById('app') as HTMLCanvasElement;
const hudRoot = document.getElementById('hud')!;
const doorRoot = document.getElementById('door-ui')!;
const debriefRoot = document.getElementById('debrief')!;

const sim = createWorld('GH-FIRE-MVS');
(window as unknown as { __sim: typeof sim }).__sim = sim;

const { scene, camera, renderer } = createScene();
renderer.setSize(window.innerWidth, window.innerHeight);
canvas.replaceWith(renderer.domElement);
renderer.domElement.id = 'app';

const agents = createAgents(scene);
const smoke = createSmoke(scene);
const hud = createHud(hudRoot);
const doorUi = createDoorUi(doorRoot);

window.addEventListener('resize', () => {
  const aspect = window.innerWidth / window.innerHeight;
  const frustum = 16;
  camera.left = -frustum * aspect;
  camera.right = frustum * aspect;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'Enter' && sim.phase === 'plan') {
    sim.phase = 'execute';
    sim.crew.order = { kind: 'search', floor: 1 };
  }
  if (e.code === 'KeyT' && sim.phase === 'execute') {
    for (let i = 0; i < 600; i++) stepSim(sim, 1 / 20);
  }
});

const DT = 1 / 20;
let acc = 0;
let last = performance.now();

function frame(now: number) {
  requestAnimationFrame(frame);
  const raw = Math.min((now - last) / 1000, 0.25);
  last = now;

  if (sim.phase === 'execute') {
    acc += raw;
    while (acc >= DT) {
      stepSim(sim, DT);
      acc -= DT;
    }
    if (sim.door.opened) {
      sim.phase = 'debrief';
      debriefRoot.style.display = 'block';
      renderDebrief(debriefRoot, buildDebrief(sim));
    }
  }

  agents.update(sim);
  smoke.update(sim);
  hud.update(sim);
  doorUi.update(sim);
  renderer.render(scene, camera);
}

requestAnimationFrame(frame);
