// Prueba del flujo completo contra portales SIMULADOS: nada sale a internet.
// Cada "portal" es una página falsa con los mismos campos que el real; el test
// hace de persona (completa el captcha falso) y verifica envío, lectura y resumen.
//   npm test
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as M from '../consulta-patente.mjs';

const out = await fs.mkdtemp(path.join(os.tmpdir(), 'consulta-patente-test-'));
const hoy = new Date();
const mesesAtras = (n, dia) => new Date(hoy.getFullYear(), hoy.getMonth() - n, dia);
const fv = (d) => ({ day: d.getDate(), month: d.getMonth() + 1, year: d.getFullYear() });
const ddmmyyyy = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
const vieja = mesesAtras(84, 10), reciente = mesesAtras(4, 12), delMes = mesesAtras(0, 15), futura = mesesAtras(-2, 10);
const ctx = { patente: 'AB123CD', carpeta: out, timeoutMs: 20000, anios: 10 };
const html = (b) => ({ status: 200, contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body>${b}</body></html>` });
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
const captchaFalso = `<textarea name="g-recaptcha-response" id="g-recaptcha-response" style="display:none"></textarea>`;
const resolverCaptcha = (page, tok) => page.evaluate((t) => { document.querySelector('textarea[name="g-recaptcha-response"]').value = t; }, tok);

const browser = await chromium.launch();
async function pagina(rutas) {
  const page = await browser.newPage();
  await page.route('**/*', async (route) => {
    const u = route.request().url();
    for (const [pat, fn] of rutas) if (u.includes(pat)) return route.fulfill(await fn(route.request()));
    return route.abort();
  });
  page.on('dialog', d => d.accept());
  return page;
}
const C = Object.fromEntries(M.CONSULTAS.map(c => [c.id, c]));
const resultados = [];

// ── AGIP: primer intento con captcha inválido, después OK ──
{
  let llamadas = 0, anioPedido = null;
  const page = await pagina([
    ['/Empadronados/json/captcha/GetDatos', () => (++llamadas === 1
      ? json({ statusCode: 11, status: 'Captcha inválido' })
      : json({ statusCode: 0, result: { cabecera: { dominio: 'AB123CD', dv: '5', tipoFabrica: { descripcion: 'FIAT' }, tipoModeloFabrica: { descripcion: 'CRONOS 1.3' }, tipoEstado: { descripcion: 'ACTIVO' }, fechaBaja: '' } } }))],
    ['/Empadronados/json/GetPosicionesImpagas', (req) => { anioPedido = new URLSearchParams(req.postData()).get('anioInicio'); return json({ statusCode: 0, result: { deudas: [
      { anio: vieja.getFullYear(), cuota: 3, fechaVencimiento: fv(vieja), importeActualizado: 15000.5 },
      { anio: reciente.getFullYear(), cuota: 5, fechaVencimiento: fv(mesesAtras(5, 12)), importeActualizado: 0 },
      { anio: reciente.getFullYear(), cuota: 6, fechaVencimiento: fv(reciente), importeActualizado: 20000 },
      { anio: delMes.getFullYear(), cuota: 10, fechaVencimiento: fv(delMes), importeActualizado: 30000 },
      { anio: futura.getFullYear(), cuota: 11, fechaVencimiento: fv(futura), importeActualizado: 31000 },
    ] } }); }],
    ['/ConsultaPat/', () => html(`<input id="fldDominio"><input id="fldDominio2">${captchaFalso}
      <button id="btnConsultar" onclick="go()">Consultar</button>
      <script>async function go(){ const r=await fetch('/Empadronados/json/captcha/GetDatos',{method:'POST',body:new URLSearchParams({dominio:fldDominio.value})}); const j=await r.json();
        document.querySelector('textarea').value=''; if(j.statusCode===0) fetch('/Empadronados/json/GetPosicionesImpagas',{method:'POST',body:'codImpuesto=8&anioInicio=2025'}); }</script>`)],
  ]);
  await C['patente-caba'].preparar(page, ctx);
  assert.equal(await page.inputValue('#fldDominio2'), 'AB123CD');
  const estado = { terminado: false, envios: 0 };
  const p = C['patente-caba'].esperar(page, ctx, estado);
  await resolverCaptcha(page, 'token-1');           // la "persona" resuelve -> falla
  await page.waitForTimeout(4000);
  await resolverCaptcha(page, 'token-2');           // la "persona" resuelve de nuevo -> OK
  const r = await p; estado.terminado = true;
  assert.equal(llamadas, 2, 'debió reintentar una vez');
  assert.equal(anioPedido, String(new Date().getFullYear() - 10), 'debió pedir 10 años hacia atrás');
  assert.equal(r.estado, 'ok'); assert.equal(r.items.length, 3);
  assert.equal(r.total, 15000.5 + 20000 + 30000);
  assert.match(r.extra, /1 cuota\(s\) a vencer/);
  assert.match(r.items[0].nota, /\+5 años/);
  assert.equal(r.items[2].estado, 'del mes en curso');
  assert.match(r.encabezado, /FIAT CRONOS/);
  resultados.push({ ...r, id: 'patente-caba', titulo: C['patente-caba'].titulo, captura: 'patente-caba.png' });
  console.log('✔ AGIP OK (reintento + 10 años + clasificación)');
}

// ── AGIP: no radicado ──
{
  const page = await pagina([
    ['/Empadronados/json/captcha/GetDatos', () => json({ statusCode: 3, status: 'El dominio no se encuentra radicado en la Ciudad' })],
    ['/ConsultaPat/', () => html(`<input id="fldDominio"><input id="fldDominio2">${captchaFalso}<button id="btnConsultar" onclick="fetch('/Empadronados/json/captcha/GetDatos',{method:'POST'})">C</button>`)],
  ]);
  await C['patente-caba'].preparar(page, ctx);
  const estado = { terminado: false, envios: 0 };
  const p = C['patente-caba'].esperar(page, ctx, estado);
  await resolverCaptcha(page, 'tok');
  const r = await p; estado.terminado = true;
  assert.equal(r.tipo, 'no-aplica'); assert.match(r.mensaje, /no se encuentra radicado/);
  console.log('✔ AGIP no radicado OK');
}

// ── ARBA: resultado HTML con tabla ──
{
  const page = await pagina([
    ['/AvisoDeudas/generarAviso.do', () => html(`<h2>Aviso de deuda</h2><table><tr><th>Año</th><th>Cuota</th><th>Vencimiento</th><th>Importe</th></tr>
       <tr><td>2025</td><td>3</td><td>15/05/2025</td><td>$ 45.123,50</td></tr><tr><td>2025</td><td>4</td><td>15/07/2025</td><td>$ 45.123,50</td></tr></table>`)],
    ['/AvisoDeudas/', () => html(`<form id="generarAvisoForm" method="post" action="/AvisoDeudas/generarAviso.do"><input id="patente" name="patente"></form>
       <div id="captchaform"><img id="captcha"><input id="captcha-respuesta"></div><button id="consultar" onclick="document.forms[0].submit()">Consultar</button>`)],
  ]);
  await C['patente-pba'].preparar(page, ctx);
  assert.equal(await page.inputValue('#patente'), 'AB123CD');
  const p = C['patente-pba'].esperar(page, ctx, { terminado: false, envios: 0 });
  await page.fill('#captcha-respuesta', 'aB3xY9'); await page.click('#consultar');   // la "persona" tipea el código
  const r = await p;
  assert.equal(r.tipo, 'generico'); assert.equal(r.sinDeuda, false); assert.equal(r.tablas[0].length, 3);
  resultados.push({ ...r, id: 'patente-pba', titulo: C['patente-pba'].titulo, captura: 'patente-pba.png' });
  console.log('✔ ARBA Aviso de Deudas (respaldo con captcha) OK');
}

// ── CABA multas: error de captcha y después "sin infracciones" ──
{
  let posts = 0;
  const form = (alerta) => html(`<main><div class="alert alert-danger ${alerta ? '' : 'd-none'}" role="alert">${alerta}</div>
    <form id="infracciones-form" method="POST" action="index.php">
     <div class="custom-control custom-radio" id="radioDom" onclick="document.getElementById('panel-dominio').classList.remove('d-none');document.getElementById('edit-tipo-consulta-dominio').checked=true">
       <input class="custom-control-input" type="radio" name="tipo_consulta" value="Dominio" id="edit-tipo-consulta-dominio" style="opacity:0"><label>Una patente</label></div>
     <div class="d-none" id="panel-dominio"><input type="text" id="edit-dominio" name="dominio"></div>${captchaFalso}
     <button type="submit">Consultar</button></form></main><style>.d-none{display:none}</style>`);
  const page = await pagina([
    ['consulta-de-infracciones/index.php', () => (++posts === 1 ? form('Verificá el captcha') : html(`<main><div class="libreDeuda-view">No registrás infracciones de tránsito.</div></main>`))],
    ['consulta-de-infracciones/', () => form('')],
  ]);
  await C['multas-caba'].preparar(page, ctx);
  assert.equal(await page.inputValue('#edit-dominio'), 'AB123CD');
  const estado = { terminado: false, envios: 0 };
  const p = C['multas-caba'].esperar(page, ctx, estado);
  await resolverCaptcha(page, 't1');
  await page.waitForTimeout(4000);
  assert.equal(await page.inputValue('#edit-dominio'), 'AB123CD', 'debió volver a completar la patente');
  await resolverCaptcha(page, 't2');
  const r = await p; estado.terminado = true;
  assert.equal(posts, 2); assert.equal(r.sinDeuda, true);
  resultados.push({ ...r, id: 'multas-caba', titulo: C['multas-caba'].titulo, captura: 'multas-caba.png' });
  console.log('✔ Multas CABA OK (reintento + sin infracciones)');
}

// ── PBA multas: JSON con actas ──
{
  let urlPedida = '';
  const page = await pagina([
    ['/rest/consultar-infraccion', (req) => { urlPedida = req.url(); return json({ error: false, totalRegistros: 12, infracciones: [
      { nroCausa: '01-123-00456789-0', fechaInfraccion: mesesAtras(36, 1).getTime(), importeTotal: 98765.4, estadoCausaPublico: { descripcion: 'Pendiente de pago', colorHex: 'f00' }, autoridadAplicacion: 'Juzgado de Faltas de Pilar' },
      { nroCausa: '01-999-00000001-0', fechaInfraccion: ddmmyyyy(mesesAtras(1, 15)), importeTotal: 120000, estadoCausaPublico: { descripcion: 'En término' }, conApremio: false },
    ] }); }],
    ['/consulta-infraccion', () => html(`<div id="x-domain"><input id="filtroDominio">${captchaFalso}
       <button type="submit" id="calltoaction" class="btn bt-form-search" onclick="fetch('/rest/consultar-infraccion?dominio='+filtroDominio.value+'&reCaptcha='+document.querySelector('textarea').value+'&cantPorPagina=10&paginaActual=1')">Buscar</button></div>`)],
  ]);
  await C['multas-pba'].preparar(page, ctx);
  const estado = { terminado: false, envios: 0 };
  const p = C['multas-pba'].esperar(page, ctx, estado);
  await resolverCaptcha(page, 'tok-pba');
  const r = await p; estado.terminado = true;
  assert.match(urlPedida, /dominio=AB123CD/);
  assert.equal(r.items.length, 2); assert.equal(r.total, 98765.4 + 120000);
  assert.match(r.items[0].nota, /\+2 años/); assert.equal(r.items[1].nota, '');
  assert.match(r.extra, /12 actas/);
  resultados.push({ ...r, id: 'multas-pba', titulo: C['multas-pba'].titulo, captura: 'multas-pba.png' });
  console.log('✔ Multas PBA OK (JSON + prescripción + paginado)');
}

// ── Sin doble envío si la persona aprieta el botón a mano ──
{
  let n = 0;
  const page = await pagina([
    ['/rest/consultar-infraccion', () => { n++; return json({ error: false, infracciones: [] }); }],
    ['/consulta-infraccion', () => html(`<div id="x-domain"><input id="filtroDominio">${captchaFalso}<button class="bt-form-search" onclick="fetch('/rest/consultar-infraccion?d=1')">Buscar</button></div>`)],
  ]);
  await C['multas-pba'].preparar(page, ctx);
  const estado = { terminado: false, envios: 0 };
  const p = C['multas-pba'].esperar(page, ctx, estado);
  await resolverCaptcha(page, 'x'); await page.click('#x-domain button');
  const r = await p; await page.waitForTimeout(2500); estado.terminado = true;
  assert.equal(n, 1, 'no debe enviar dos veces'); assert.equal(r.sinDeuda, true);
  console.log('✔ Sin doble envío OK');
}
await browser.close();

// ── Resumen ──
const resumen = M.armarResumen('AB123CD', hoy, resultados, out);
await fs.writeFile(out + '/resumen.md', resumen);
console.log('\n' + resumen);
assert.equal(M.normalizarPatente(' ab-123 cd '), 'AB123CD'); assert.equal(M.normalizarPatente('abc 123'), 'ABC123'); assert.equal(M.normalizarPatente('A123BCD'), null);
assert.equal(M.aNumero('$ 12.345,67'), 12345.67); assert.equal(M.aNumero('12,345.67'), 12345.67);
// ── ARBA liquidación sin captcha (respuestas con el mismo HTML que devuelve ARBA) ──
{
  const { default: zlib } = await import('node:zlib');
  const pagina = (msj) => Buffer.from(`<table><tr><td class="lineaColor"><span class="tituloOpcion">Mensaje</span></td></tr>
    <tr><td><span class="txtAdvertencia"><br><br>${msj}<br><br></span></td></tr></table>`, 'latin1');
  const sin = M.interpretarLiquidacionArba('text/html;charset=ISO-8859-1', pagina('NO EXISTE DEUDA PARA EL CONTRIBUYENTE INGRESADO'));
  assert.equal(sin.sinDeuda, true); assert.match(sin.textoSinDeuda, /NO EXISTE DEUDA/);
  const inex = M.interpretarLiquidacionArba('text/html', pagina('DOMINIO INEXISTENTE EN BASE DE DATOS'));
  assert.equal(inex.tipo, 'no-aplica'); assert.match(inex.mensaje, /no está registrado en Provincia/);
  assert.equal(M.interpretarLiquidacionArba('text/html', Buffer.from('<html>otra cosa</html>')), null);
  const contenido = zlib.deflateSync(Buffer.from('BT /F1 9 Tf 10 10 Td (Dominio NQM444) Tj ET BT (Total a pagar: $ 123.456,78) Tj ET BT [(Cuota ) -20 (3/2026)] TJ ET', 'latin1'));
  const pdf = Buffer.concat([Buffer.from(`%PDF-1.4\n1 0 obj << /Length ${contenido.length} /Filter /FlateDecode >>\nstream\n`), contenido, Buffer.from('\nendstream\nendobj\n%%EOF')]);
  assert.deepEqual(M.textoDePdf(pdf), ['Dominio NQM444', 'Total a pagar: $ 123.456,78', 'Cuota 3/2026']);
  const conDeuda = M.interpretarLiquidacionArba('application/pdf', pdf);
  assert.equal(conDeuda.sinDeuda, false); assert.deepEqual(conDeuda.lineas, ['Total a pagar: $ 123.456,78']);
  console.log('✔ ARBA liquidación OK (sin deuda / inexistente / PDF)');
}
console.log('\nTODO OK');
