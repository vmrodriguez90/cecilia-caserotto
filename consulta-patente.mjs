#!/usr/bin/env node
/**
 * consulta-patente.mjs
 *
 * Dada una patente argentina, consulta en los portales OFICIALES:
 *   - Deuda de patente CABA        (AGIP  - lb.agip.gob.ar)
 *   - Deuda de patente PBA         (ARBA  - arba.gov.ar, impuesto automotor)
 *   - Multas de tránsito CABA      (buenosaires.gob.ar)
 *   - Multas de tránsito PBA       (InfraccionesBA - infraccionesba.gba.gob.ar)
 *
 * ARBA se consulta con su liquidación oficial sin captcha. Los otros portales
 * piden captcha: el script abre un navegador visible, completa la patente y
 * espera a que VOS resuelvas cada captcha. Nunca intenta resolverlo, nunca paga
 * ni inicia pagos: sólo lee lo que muestra cada portal.
 *
 * Uso:  node consulta-patente.mjs NQM444
 */
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { parseArgs } from 'node:util';

const URLS = {
  patenteCaba: 'https://lb.agip.gob.ar/ConsultaPat/',
  patentePba: 'https://app.arba.gov.ar/AvisoDeudas/?imp=1',
  // "Liquidación contado y sin trámite" de ARBA: formulario oficial sin captcha.
  arbaLiquidacionForm:
    'http://www14.arba.gov.ar/Liquidacion/jsp/generarLiquidacion.jsp?imp=1&leyenda=Liquidacion+contado+sin+tramite&opcion=2',
  arbaLiquidacion: 'http://www14.arba.gov.ar/Liquidacion/liquidacion.do',
  multasCaba: 'https://buenosaires.gob.ar/licenciasdeconducir/consulta-de-infracciones/?actas=transito',
  multasPba: 'https://infraccionesba.gba.gob.ar/consulta-infraccion',
};

const AYUDA = `
Uso:  node consulta-patente.mjs <PATENTE> [opciones]

  <PATENTE>            AB123CD o ABC123 (mayúsculas/minúsculas, con o sin espacios o guiones)

Opciones:
  --solo <lista>       Consultar sólo algunas fuentes, separadas por coma:
                       patente-caba, patente-pba, multas-caba, multas-pba
  --minutos <n>        Minutos máximos de espera por cada portal (default 5)
  --anios <n>          Años hacia atrás para buscar cuotas vencidas en AGIP (default 10)
  --salida <carpeta>   Dónde guardar el reporte (default ./resultados)
  --navegador <x>      chrome | chromium (default: Chrome si está instalado)
  --cerrar             Cerrar el navegador al terminar sin preguntar
  -h, --help           Mostrar esta ayuda

Mientras espera un portal, escribí "s" + Enter para saltearlo.
`;

// ───────────────────────────── utilidades ─────────────────────────────

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

class TiempoAgotado extends Error {
  constructor() {
    super('Se agotó el tiempo de espera.');
    this.name = 'TimeoutError';
  }
}

export function normalizarPatente(texto) {
  const p = String(texto ?? '').toUpperCase().replace(/[\s.\-_]/g, '');
  if (/^[A-Z]{3}\d{3}$/.test(p) || /^[A-Z]{2}\d{3}[A-Z]{2}$/.test(p)) return p;
  return null;
}

const formatoMoneda = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' });
export function moneda(n) {
  return typeof n === 'number' && Number.isFinite(n) ? formatoMoneda.format(n) : '—';
}

export function aNumero(v) {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string' || !v.trim()) return null;
  // "$ 12.345,67" | "12345.67" | "12,345.67"
  let s = v.replace(/[^\d.,-]/g, '');
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function aFecha(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v);
  if (typeof v === 'object' && v.year) return new Date(v.year, (v.month || 1) - 1, v.day || 1);
  if (typeof v === 'string') {
    const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export function fechaCorta(d) {
  if (!d) return 's/f';
  const dos = (n) => String(n).padStart(2, '0');
  return `${dos(d.getDate())}/${dos(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function fechaHora(d) {
  const dos = (n) => String(n).padStart(2, '0');
  return `${fechaCorta(d)} ${dos(d.getHours())}:${dos(d.getMinutes())}`;
}

function sello(d) {
  const dos = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}_${dos(d.getHours())}${dos(d.getMinutes())}`;
}

function aniosDesde(fecha, hoy = new Date()) {
  return fecha ? (hoy - fecha) / (365.25 * 24 * 3600 * 1000) : 0;
}

/** Devuelve un texto legible de un valor que puede venir como string u objeto {descripcion}. */
function texto(v) {
  if (v == null) return '';
  if (typeof v === 'object') return v.descripcion ?? v.nombre ?? v.detalle ?? '';
  return String(v).trim();
}

function primero(obj, claves) {
  for (const k of claves) {
    const t = texto(obj?.[k]);
    if (t) return t;
  }
  return '';
}

/**
 * Repite `intento(msRestantes)` hasta que devuelva algo distinto de null
 * o se agote el tiempo.
 */
async function hastaQue(ms, intento) {
  const limite = Date.now() + ms;
  for (;;) {
    const resto = limite - Date.now();
    if (resto <= 0) throw new TiempoAgotado();
    const r = await intento(resto);
    if (r) return r;
  }
}

/**
 * Cuando la persona resuelve un reCAPTCHA en la página, aprieta el botón de
 * consulta. No toca el captcha: sólo detecta que ya tiene respuesta.
 */
function autoEnviarAlResolver(page, selectorBoton, estado) {
  (async () => {
    let ultimo = '';
    let base = estado.envios; // envíos registrados antes de que apareciera el token actual
    while (!estado.terminado && !page.isClosed()) {
      try {
        const token = await page.evaluate(
          () =>
            [...document.querySelectorAll('textarea[name="g-recaptcha-response"]')]
              .map((t) => t.value)
              .find(Boolean) || '',
        );
        if (!token || token === ultimo) {
          base = estado.envios;
        } else {
          ultimo = token;
          await esperar(1500); // por si la persona aprieta el botón a mano
          if (estado.envios === base && !estado.terminado) {
            await page.click(selectorBoton, { timeout: 5000 });
          }
          base = estado.envios;
        }
      } catch {
        // la página puede estar navegando; se reintenta en la próxima vuelta
      }
      await esperar(700);
    }
  })();
}

/** Cuenta las solicitudes de consulta que salen de la página (para no duplicar envíos). */
function contarEnvios(page, estado, esEnvio) {
  const fn = (req) => {
    try {
      if (esEnvio(req)) estado.envios++;
    } catch {}
  };
  page.on('request', fn);
  return () => page.off('request', fn);
}

/**
 * Espera a que la pestaña envíe un formulario (navegación que cumple `esEnvio`)
 * y a que el documento NUEVO termine de cargar. Devuelve { req, resp }.
 */
function esperarDocumentoNuevo(page, esEnvio, timeout) {
  return new Promise((resolve, reject) => {
    let req = null;
    let hecho = false;
    const fin = (fn) => {
      if (hecho) return;
      hecho = true;
      clearTimeout(reloj);
      page.off('request', alPedir);
      page.off('response', alResponder);
      page.off('domcontentloaded', alCargar);
      page.off('close', alCerrar);
      fn();
    };
    const alPedir = (r) => {
      if (r.isNavigationRequest() && r.frame() === page.mainFrame() && esEnvio(r)) req = r;
    };
    // Un PDF puede no disparar domcontentloaded: lo resolvemos al llegar la respuesta.
    const alResponder = (resp) => {
      if (req && resp.request() === req && /pdf/i.test(resp.headers()['content-type'] || '')) fin(() => resolve({ req, resp }));
    };
    const alCargar = async () => {
      if (!req) return;
      const resp = await req.response().catch(() => null);
      await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
      fin(() => resolve({ req, resp }));
    };
    const alCerrar = () => fin(() => reject(new Error('Se cerró la pestaña (closed).')));
    const reloj = setTimeout(() => fin(() => reject(new TiempoAgotado())), timeout);
    page.on('request', alPedir);
    page.on('response', alResponder);
    page.on('domcontentloaded', alCargar);
    page.on('close', alCerrar);
  });
}

/** Extrae texto y tablas visibles de la página (para portales que devuelven HTML). */
async function extraerContenido(page, selector) {
  return page.evaluate((sel) => {
    const raiz = (sel && document.querySelector(sel)) || document.body;
    const limpio = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const tablas = [...raiz.querySelectorAll('table')]
      .filter(visible)
      .map((t) => [...t.rows].map((tr) => [...tr.cells].map((td) => limpio(td.innerText))).filter((f) => f.some(Boolean)))
      .filter((t) => t.length);
    const libre = !!document.querySelector('.libreDeuda-view, [class*="libreDeuda"], [class*="libre-deuda"]');
    return { texto: raiz.innerText || '', tablas, libre };
  }, selector);
}

const RE_SIN_DEUDA =
  /(no\s+(registra|registr[aá]s|posee|pose[eé]s|tiene|ten[eé]s|existen|se\s+encontraron|hay|se\s+registran)[^.\n]{0,60}(infracci|deuda|acta|multa|cuota|boleta|saldo))|libre\s+de\s+deuda|sin\s+deuda/i;

/** Arma un resultado "best effort" a partir de una página HTML de resultados. */
export function resultadoGenerico(contenido) {
  const lineas = contenido.texto
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l && (/\$\s?\d/.test(l) || /\b\d{2}\/\d{2}\/\d{4}\b/.test(l) || /\btotal\b/i.test(l)));
  const conMontos = lineas.some((l) => /\$\s?\d/.test(l)) || contenido.tablas.some((t) => t.some((f) => f.some((c) => /\$\s?\d/.test(c))));
  const sinDeuda = (contenido.libre || RE_SIN_DEUDA.test(contenido.texto)) && !conMontos;
  return {
    estado: 'ok',
    tipo: 'generico',
    sinDeuda,
    tablas: contenido.tablas,
    lineas: [...new Set(lineas)].slice(0, 40),
    texto: contenido.texto,
  };
}

async function guardar(ctx, nombre, contenido) {
  try {
    await fs.writeFile(path.join(ctx.carpeta, nombre), contenido);
  } catch {}
}

const suma = (arr) => arr.reduce((s, i) => s + (i.monto ?? 0), 0);

/** Separa las boletas impagas de AGIP en vencidas/del mes (items) y a vencer. */
export function clasificarBoletasAgip(deudas, hoy = new Date()) {
  const mesActual = `${hoy.getMonth()}/${hoy.getFullYear()}`;
  const items = [];
  const aVencer = [];
  for (const b of deudas ?? []) {
    const monto = aNumero(b.importeActualizado);
    if (!(monto > 0.01)) continue; // el sitio también oculta las de importe 0
    const vto = aFecha(b.fechaVencimiento);
    const abrev = texto(b.abreviatura);
    const item = {
      fecha: vto,
      descripcion: `${b.anio ?? '?'} cuota ${String(b.cuota ?? '?').padStart(2, '0')}${abrev && abrev !== 'CUOTA' ? ` (${abrev})` : ''}`,
      monto,
      estado: '',
    };
    const esMesActual = !!vto && `${vto.getMonth()}/${vto.getFullYear()}` === mesActual;
    if (vto && vto > hoy && !esMesActual) {
      aVencer.push(item);
    } else {
      item.estado = esMesActual ? 'del mes en curso' : 'vencida';
      if (!esMesActual && aniosDesde(vto, hoy) > 5) item.nota = '+5 años: podría estar prescripta (orientativo)';
      items.push(item);
    }
  }
  const porFecha = (a, b) => (a.fecha ?? 0) - (b.fecha ?? 0);
  return { items: items.sort(porFecha), aVencer: aVencer.sort(porFecha) };
}

/** Convierte las actas que devuelve InfraccionesBA en items del reporte. */
export function itemsMultasPba(actas, hoy = new Date()) {
  return (actas ?? [])
    .map((a) => {
      const fecha = aFecha(a.fechaInfraccion ?? a.fechaActa ?? a.fecha);
      const estados = [
        texto(a.estadoCausaPublico) || texto(a.estado),
        a.esPlanPago && 'con plan de pago',
        a.conApremio && 'con apremio',
      ].filter(Boolean);
      const anios = aniosDesde(fecha, hoy);
      return {
        fecha,
        descripcion: [
          a.nroCausa && `causa ${a.nroCausa}`,
          primero(a, ['descripcionInfraccion', 'infraccion', 'descripcion', 'motivo']),
          primero(a, ['lugarInfraccion', 'lugar', 'partido', 'municipio', 'autoridadAplicacion']),
        ]
          .filter(Boolean)
          .join(' · '),
        monto: aNumero(a.importeTotal ?? a.importe ?? a.monto),
        estado: estados.join(', '),
        nota:
          anios > 5
            ? '+5 años: podría estar prescripta (orientativo)'
            : anios > 2
              ? '+2 años: podría estar prescripta si es leve (orientativo)'
              : '',
      };
    })
    .sort((a, b) => (a.fecha ?? 0) - (b.fecha ?? 0));
}

/** Extrae (best effort) las líneas de texto de un PDF simple, sin dependencias. */
export function textoDePdf(buf) {
  const crudo = buf.toString('latin1');
  const desescapar = (t) =>
    t.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, c) =>
      /^[0-7]+$/.test(c) ? String.fromCharCode(parseInt(c, 8)) : ({ n: '\n', r: '\r', t: '\t', b: '', f: '' }[c] ?? c),
    );
  const lineas = [];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(crudo))) {
    const ini = m.index + m[0].length;
    const fin = crudo.indexOf('endstream', ini);
    if (fin < 0) break;
    re.lastIndex = fin;
    let datos = buf.subarray(ini, fin);
    try {
      datos = zlib.inflateSync(datos);
    } catch {
      try {
        datos = zlib.inflateSync(datos, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
      } catch {}
    }
    for (const bloque of datos.toString('latin1').match(/\bBT\b[\s\S]*?\bET\b/g) ?? []) {
      const partes = [...bloque.matchAll(/\(((?:\\[\s\S]|[^\\)])*)\)/g)].map((x) => desescapar(x[1]));
      const linea = partes.join('').replace(/\s+/g, ' ').trim();
      if (linea) lineas.push(linea);
    }
  }
  return lineas;
}

/**
 * Interpreta la respuesta de la "Liquidación contado y sin trámite" de ARBA.
 * Devuelve null si no la reconoce (entonces se usa el Aviso de Deudas con captcha).
 */
export function interpretarLiquidacionArba(tipoContenido, cuerpo) {
  if (/pdf/i.test(tipoContenido) || cuerpo.subarray(0, 5).toString('latin1') === '%PDF-') {
    const lineas = textoDePdf(cuerpo);
    const relevantes = lineas.filter((l) => /\$\s?\d|\b\d{1,3}(\.\d{3})*,\d{2}\b|total/i.test(l));
    return {
      estado: 'ok',
      tipo: 'generico',
      fuente: 'PDF',
      pdf: cuerpo,
      encabezado: 'ARBA generó una liquidación: el auto tiene deuda de patente. El detalle está en el PDF.',
      sinDeuda: false,
      tablas: [],
      lineas: relevantes.slice(0, 20),
      texto: lineas.join('\n'),
    };
  }
  const html = cuerpo.toString('latin1');
  const limpiar = (h) =>
    h
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/[ \t]+/g, ' ');
  const aviso = html.match(/class="txtAdvertencia"[^>]*>([\s\S]*?)<\/span>/i);
  const mensaje = aviso ? limpiar(aviso[1]).replace(/\s+/g, ' ').trim() : '';
  if (/no existe deuda/i.test(mensaje)) {
    return {
      estado: 'ok',
      tipo: 'items',
      items: [],
      sinDeuda: true,
      textoSinDeuda: `ARBA: "${mensaje}"`,
      extra:
        'Es la liquidación al contado: deuda en juicio (apremio) o en plan de pagos podría no figurar acá. Para verla completa: Aviso de Deudas de ARBA.',
    };
  }
  if (/dominio inexistente/i.test(mensaje)) {
    return {
      estado: 'ok',
      tipo: 'no-aplica',
      mensaje: `ARBA respondió "${mensaje}": el auto no está registrado en Provincia de Buenos Aires (si es de CABA u otra provincia, es normal).`,
    };
  }
  if (mensaje) return { estado: 'ok', tipo: 'no-aplica', mensaje: `ARBA respondió: "${mensaje}"` };
  // Sin mensaje: si es una página de liquidación con montos, la leemos genéricamente.
  const texto = limpiar(html);
  if (/liquidaci/i.test(texto) && /\$\s?\d|\d,\d{2}\b/.test(texto)) {
    return { ...resultadoGenerico({ texto, tablas: [], libre: false }), fuente: 'HTML' };
  }
  return null;
}

// ───────────────────────────── portales ─────────────────────────────

/** Deuda de patente CABA (AGIP). Respuestas en JSON. */
const patenteCaba = {
  id: 'patente-caba',
  titulo: 'Deuda de patente CABA (AGIP)',
  instrucciones: 'Resolvé el captcha ("No soy un robot"). El script aprieta "Consultar" solo.',

  async completar(page, ctx) {
    await page.waitForSelector('#fldDominio', { state: 'visible', timeout: 30000 });
    await page.fill('#fldDominio', ctx.patente);
    if (await page.isVisible('#fldDominio2')) await page.fill('#fldDominio2', ctx.patente);
  },

  async preparar(page, ctx) {
    await page.goto(URLS.patenteCaba, { waitUntil: 'domcontentloaded' });
    await this.completar(page, ctx);
  },

  async esperar(page, ctx, estado) {
    const quitar = contarEnvios(page, estado, (r) => r.url().includes('/Empadronados/json/captcha/GetDatos'));
    const impagasDelSitio = [];
    const capturarImpagas = async (resp) => {
      if (resp.url().includes('/Empadronados/json/GetPosicionesImpagas')) {
        try {
          impagasDelSitio.push(await resp.json());
        } catch {}
      }
    };
    page.on('response', capturarImpagas);
    autoEnviarAlResolver(page, '#btnConsultar', estado);

    try {
      const datos = await hastaQue(ctx.timeoutMs, async (resto) => {
        const resp = await page.waitForResponse((r) => r.url().includes('/Empadronados/json/captcha/GetDatos'), {
          timeout: resto,
        });
        const body = await resp.json().catch(() => null);
        if (body?.statusCode === 0 && body.result?.cabecera) return body;
        const msj = texto(body?.status) || `respuesta inesperada (HTTP ${resp.status()})`;
        if (/captcha|verificaci|robot|casilla/i.test(msj)) {
          console.log(`  ⚠ AGIP: ${msj}. Resolvé el captcha de nuevo.`);
          return null;
        }
        return { noAplica: msj, crudo: body };
      });

      if (datos.noAplica) {
        return {
          estado: 'ok',
          tipo: 'no-aplica',
          mensaje: `AGIP respondió: "${datos.noAplica}" (si el auto no está radicado en CABA, es normal).`,
          crudo: datos.crudo,
        };
      }

      const cab = datos.result.cabecera;
      const vehiculo = [texto(cab.tipoFabrica), texto(cab.tipoModeloFabrica)].filter(Boolean).join(' ');
      const encabezado = [
        vehiculo && `Vehículo: ${vehiculo}`,
        texto(cab.tipoEstado) && `estado: ${texto(cab.tipoEstado)}`,
        cab.fechaBaja && `baja: ${cab.fechaBaja}`,
      ]
        .filter(Boolean)
        .join(' · ');

      // El sitio, por defecto, sólo muestra cuotas vencidas desde el año pasado.
      // Pedimos desde hace `ctx.anios` años (equivale a cambiar el año en el calendario del sitio).
      const anioInicio = new Date().getFullYear() - ctx.anios;
      let deudaJson = await page
        .evaluate(
          async ({ dominio, dv, anio }) => {
            const params = new URLSearchParams({ codImpuesto: '8', anioInicio: String(anio), dominioI: dominio });
            if (dv !== undefined && dv !== null) params.set('dv', String(dv));
            const r = await fetch('/Empadronados/json/GetPosicionesImpagas', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest',
              },
              body: params.toString(),
            });
            return r.ok ? r.json() : null;
          },
          { dominio: cab.dominio ?? ctx.patente, dv: cab.dv, anio: anioInicio },
        )
        .catch(() => null);

      let desde = anioInicio;
      const valida = (j) => j && (j.statusCode === 0 || /SELECCION/.test(j.status || ''));
      if (!valida(deudaJson)) {
        // Plan B: usar lo que pidió el propio sitio (desde el año pasado).
        for (let i = 0; i < 40 && !impagasDelSitio.some(valida); i++) await esperar(500);
        deudaJson = impagasDelSitio.find(valida) ?? null;
        desde = new Date().getFullYear() - 1;
      }
      if (!deudaJson) {
        return {
          estado: 'error',
          encabezado,
          mensaje: 'Se obtuvieron los datos del vehículo pero no el estado de cuenta. Revisá la pestaña de AGIP.',
          crudo: { datos },
        };
      }

      const { items, aVencer } = clasificarBoletasAgip(deudaJson.result?.deudas);
      return {
        estado: 'ok',
        tipo: 'items',
        encabezado,
        sustantivo: ['cuota impaga (vencida o del mes)', 'cuotas impagas (vencidas o del mes)'],
        items,
        total: suma(items),
        sinDeuda: items.length === 0,
        textoSinDeuda: `Sin cuotas vencidas desde ${desde}`,
        extra: aVencer.length ? `Además hay ${aVencer.length} cuota(s) a vencer por ${moneda(suma(aVencer))}.` : '',
        crudo: { datos, deuda: deudaJson },
      };
    } finally {
      quitar();
      page.off('response', capturarImpagas);
    }
  },
};

/** Deuda de patente PBA (ARBA, impuesto automotor). Captcha de imagen; resultado en HTML. */
const patentePba = {
  id: 'patente-pba',
  titulo: 'Deuda de patente Provincia de Buenos Aires (ARBA)',
  instrucciones: 'Escribí el código de la imagen (respetando mayúsculas) y apretá el botón de consultar.',

  /** Primero se usa la liquidación oficial sin captcha; si falla, el Aviso de Deudas (con captcha). */
  async sinCaptcha(contexto, ctx) {
    await contexto.request.get(URLS.arbaLiquidacionForm, { timeout: 30000 }); // abre la sesión
    const resp = await contexto.request.get(
      `${URLS.arbaLiquidacion}?imp=1&patente=${encodeURIComponent(ctx.patente)}&tipoLiquidacion=1`,
      { timeout: 120000, maxRedirects: 0 },
    );
    if (resp.status() !== 200) return null;
    const cuerpo = await resp.body();
    const r = interpretarLiquidacionArba(resp.headers()['content-type'] || '', cuerpo);
    if (!r) return null;
    if (r.pdf) {
      const archivo = 'patente-pba-liquidacion.pdf';
      await guardar(ctx, archivo, r.pdf);
      delete r.pdf;
      r.encabezado += ` (${archivo})`;
    } else {
      await guardar(ctx, 'patente-pba.html', cuerpo);
    }
    return r;
  },

  async completar(page, ctx) {
    if (!(await page.isVisible('#patente'))) await page.click('#btnAutomotor').catch(() => {});
    await page.waitForSelector('#patente', { state: 'visible', timeout: 30000 });
    await page.fill('#patente', ctx.patente);
    await page.waitForSelector('#captcha-respuesta', { timeout: 15000 }).catch(() => {});
  },

  async preparar(page, ctx) {
    await page.goto(URLS.patentePba, { waitUntil: 'domcontentloaded' });
    await this.completar(page, ctx);
  },

  async esperar(page, ctx) {
    await page.focus('#captcha-respuesta').catch(() => {});
    return hastaQue(ctx.timeoutMs, async (resto) => {
      const { resp } = await esperarDocumentoNuevo(
        page,
        (r) => r.method() === 'POST' && r.url().includes('/AvisoDeudas/'),
        resto,
      );
      if (/pdf/i.test(resp?.headers()['content-type'] || '')) {
        const archivo = 'patente-pba-aviso.pdf';
        const cuerpo = await resp.body().catch(() => null);
        if (cuerpo) await guardar(ctx, archivo, cuerpo);
        return { estado: 'ok', tipo: 'archivo', mensaje: `ARBA devolvió el aviso de deuda en PDF${cuerpo ? `: ${archivo}` : ' (miralo en la pestaña)'}.` };
      }
      const contenido = await extraerContenido(page);
      const captchaVisible = await page.isVisible('#captcha-respuesta').catch(() => false);
      if (captchaVisible && /(c[oó]digo|captcha|imagen)[^.\n]{0,40}(incorrect|inv[aá]lid|err[oó]ne)/i.test(contenido.texto)) {
        console.log('  ⚠ ARBA: el código de la imagen no coincide. Probá de nuevo.');
        await this.completar(page, ctx).catch(() => {});
        return null;
      }
      await guardar(ctx, 'patente-pba.html', await page.content());
      return resultadoGenerico(contenido);
    });
  },
};

/** Multas CABA. Formulario con reCAPTCHA; resultado en HTML. */
const multasCaba = {
  id: 'multas-caba',
  titulo: 'Multas CABA',
  instrucciones: 'Resolvé el captcha ("No soy un robot"). El script aprieta "Consultar" solo.',

  async completar(page, ctx) {
    await page.waitForSelector('#radioDom', { timeout: 30000 });
    await page.click('#radioDom');
    await page.check('#edit-tipo-consulta-dominio', { force: true }).catch(() => {});
    await page.waitForSelector('#edit-dominio', { state: 'visible', timeout: 10000 });
    await page.fill('#edit-dominio', ctx.patente);
  },

  async preparar(page, ctx) {
    await page.goto(URLS.multasCaba, { waitUntil: 'domcontentloaded' });
    await this.completar(page, ctx);
  },

  async esperar(page, ctx, estado) {
    const esEnvio = (r) =>
      r.method() === 'POST' && r.resourceType() === 'document' && r.url().includes('consulta-de-infracciones');
    const quitar = contarEnvios(page, estado, esEnvio);
    autoEnviarAlResolver(page, '#infracciones-form button[type=submit]', estado);
    try {
      return await hastaQue(ctx.timeoutMs, async (resto) => {
        await esperarDocumentoNuevo(page, esEnvio, resto);
        const error = await page.evaluate(() => {
          if (!document.querySelector('#infracciones-form')) return null;
          const a = [...document.querySelectorAll('.alert-danger')].find((e) => e.offsetParent !== null && e.innerText.trim());
          return a ? a.innerText.trim() : null;
        });
        if (error) {
          console.log(`  ⚠ CABA respondió: ${error.replace(/\s+/g, ' ')}. Probá de nuevo.`);
          await this.completar(page, ctx).catch(() => {});
          return null;
        }
        await guardar(ctx, 'multas-caba.html', await page.content());
        return resultadoGenerico(await extraerContenido(page, 'main'));
      });
    } finally {
      quitar();
    }
  },
};

/** Multas Provincia de Buenos Aires (InfraccionesBA). Respuesta en JSON. */
const multasPba = {
  id: 'multas-pba',
  titulo: 'Multas Provincia de Buenos Aires (InfraccionesBA)',
  instrucciones: 'Resolvé el captcha ("No soy un robot"). El script aprieta "Buscar" solo.',

  async completar(page, ctx) {
    await page.waitForSelector('#filtroDominio', { state: 'visible', timeout: 30000 });
    await page.fill('#filtroDominio', ctx.patente);
  },

  async preparar(page, ctx) {
    await page.goto(URLS.multasPba, { waitUntil: 'domcontentloaded' });
    await this.completar(page, ctx);
  },

  async esperar(page, ctx, estado) {
    const esConsulta = (url) => {
      try {
        return new URL(url).pathname.endsWith('/consultar-infraccion');
      } catch {
        return false;
      }
    };
    const quitar = contarEnvios(page, estado, (r) => esConsulta(r.url()));
    autoEnviarAlResolver(page, '#x-domain button.bt-form-search, #x-domain #calltoaction', estado);
    try {
      const body = await hastaQue(ctx.timeoutMs, async (resto) => {
        const resp = await page.waitForResponse((r) => esConsulta(r.url()), { timeout: resto });
        const json = await resp.json().catch(() => null);
        if (!json || json.error) {
          console.log('  ⚠ InfraccionesBA devolvió un error (¿captcha vencido?). Resolvé el captcha de nuevo.');
          return null;
        }
        return json;
      });

      const actas = body.infracciones ?? [];
      const items = itemsMultasPba(actas);
      const totalRegistros = body.totalRegistros ?? actas.length;
      return {
        estado: 'ok',
        tipo: 'items',
        sustantivo: ['acta', 'actas'],
        items,
        total: suma(items),
        sinDeuda: items.length === 0,
        textoSinDeuda: 'El dominio no posee infracciones en InfraccionesBA',
        extra:
          totalRegistros > actas.length
            ? `El portal informa ${totalRegistros} actas pero devolvió ${actas.length} en la primera página: mirá el resto en la pestaña.`
            : '',
        crudo: body,
      };
    } finally {
      quitar();
    }
  },
};

export const CONSULTAS = [patenteCaba, patentePba, multasCaba, multasPba];

// ───────────────────────────── reporte ─────────────────────────────

function bloque(r) {
  const L = [`### ${r.titulo}`];
  if (r.encabezado) L.push(`- ${r.encabezado}`);
  if (r.estado !== 'ok') {
    L.push(`- ✖ No se pudo completar: ${r.mensaje}`);
  } else if (r.tipo === 'no-aplica' || r.tipo === 'archivo') {
    L.push(`- ${r.mensaje}`);
  } else if (r.tipo === 'items') {
    if (r.sinDeuda) {
      L.push(`- ✔ ${r.textoSinDeuda}.`);
    } else {
      const [uno, varios] = r.sustantivo;
      L.push(`- ${r.items.length} ${r.items.length === 1 ? uno : varios} · total ${moneda(r.total)}`);
      for (const i of r.items.slice(0, 25)) {
        const partes = [fechaCorta(i.fecha), i.descripcion, moneda(i.monto), i.estado].filter(Boolean);
        L.push(`  - ${partes.join(' · ')}${i.nota ? `  ⚠ ${i.nota}` : ''}`);
      }
      if (r.items.length > 25) L.push(`  - … y ${r.items.length - 25} más (ver datos.json)`);
    }
    if (r.extra) L.push(`- ${r.extra}`);
  } else {
    // genérico (HTML)
    if (r.sinDeuda) {
      L.push('- ✔ El portal indica que no hay deuda/infracciones.');
    } else if (r.tablas?.length) {
      for (const t of r.tablas.slice(0, 4)) {
        for (const fila of t.slice(0, 20)) L.push(`  - ${fila.filter(Boolean).join(' · ')}`);
        if (t.length > 20) L.push(`  - … (${t.length - 20} filas más)`);
      }
    } else if (r.lineas?.length) {
      for (const l of r.lineas.slice(0, 20)) L.push(`  - ${l}`);
    } else {
      L.push(r.fuente === 'PDF' ? '- Abrí el PDF para ver cuotas y montos.' : '- No pude interpretar la respuesta automáticamente.');
    }
    if (!r.sinDeuda) {
      L.push(`- (Resumen leído del ${r.fuente ?? 'HTML'} del portal: confirmalo en ${r.captura ? 'la captura' : 'el archivo guardado'}.)`);
    }
  }
  if (r.captura) L.push(`- Captura: ${r.captura}`);
  return L;
}

export function armarResumen(patente, fecha, resultados, carpeta) {
  const porId = Object.fromEntries(resultados.map((r) => [r.id, r]));
  const L = [`# Patente ${patente}`, `Consulta: ${fechaHora(fecha)}`, ''];
  const seccion = (titulo, ids) => {
    const presentes = ids.filter((id) => porId[id]);
    if (!presentes.length) return;
    L.push(`## ${titulo}`, '');
    for (const id of presentes) L.push(...bloque(porId[id]), '');
  };
  seccion('Deuda de patente', ['patente-caba', 'patente-pba']);
  seccion('Multas de tránsito', ['multas-caba', 'multas-pba']);
  L.push(
    '## Notas',
    '',
    '- La patente se paga donde está radicado el auto: si es de CABA aparece en AGIP, si es de PBA en ARBA. Si está radicado en otra provincia no va a figurar en ninguno de los dos.',
    '- Las alertas de prescripción son orientativas, no asesoramiento legal (multas CABA: 5 años; multas PBA: 2 años leves / 5 graves; patentes: 5 años). Planes de pago, apremios o actos judiciales pueden interrumpirla.',
    '- Algunos municipios bonaerenses tienen sistemas propios no integrados a InfraccionesBA: puede haber actas que no aparezcan acá.',
    `- Capturas y datos completos: ${carpeta}`,
  );
  return L.join('\n');
}

// ───────────────────────────── navegador y flujo ─────────────────────────────

async function abrirNavegador(preferencia) {
  const perfil = path.join(os.homedir(), '.consulta-patente', 'perfil');
  await fs.mkdir(perfil, { recursive: true });
  const base = {
    headless: process.env.CONSULTA_PATENTE_HEADLESS === '1',
    viewport: null,
    acceptDownloads: true,
    locale: 'es-AR',
    args: ['--start-maximized'],
  };
  const intentos = [];
  if (process.env.CHROME_PATH) intentos.push({ executablePath: process.env.CHROME_PATH });
  if (preferencia !== 'chromium') intentos.push({ channel: 'chrome' });
  if (preferencia !== 'chrome') intentos.push({});
  let ultimoError;
  for (const extra of intentos) {
    try {
      return await chromium.launchPersistentContext(perfil, { ...base, ...extra });
    } catch (e) {
      ultimoError = e;
    }
  }
  throw new Error(
    `No pude abrir el navegador. Instalá Google Chrome o corré "npx playwright install chromium".\n${ultimoError?.message ?? ''}`,
  );
}

async function main() {
  let opciones;
  try {
    opciones = parseArgs({
      allowPositionals: true,
      options: {
        solo: { type: 'string' },
        minutos: { type: 'string', default: '5' },
        anios: { type: 'string', default: '10' },
        salida: { type: 'string', default: 'resultados' },
        navegador: { type: 'string' },
        cerrar: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (e) {
    console.error(e.message, '\n', AYUDA);
    process.exit(1);
  }
  const { values, positionals } = opciones;
  if (values.help || positionals.length === 0) {
    console.log(AYUDA);
    process.exit(values.help ? 0 : 1);
  }

  const patente = normalizarPatente(positionals.join(''));
  if (!patente) {
    console.error(`"${positionals.join(' ')}" no parece una patente de auto válida (formatos: ABC123 o AB123CD).`);
    process.exit(2);
  }

  const ids = values.solo ? values.solo.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : CONSULTAS.map((c) => c.id);
  const desconocidas = ids.filter((id) => !CONSULTAS.some((c) => c.id === id));
  if (desconocidas.length) {
    console.error(`Fuente(s) desconocida(s): ${desconocidas.join(', ')}. Opciones: ${CONSULTAS.map((c) => c.id).join(', ')}`);
    process.exit(1);
  }
  const seleccion = CONSULTAS.filter((c) => ids.includes(c.id));
  const minutos = Math.max(1, Number(values.minutos) || 5);
  const fecha = new Date();
  const carpeta = path.resolve(values.salida, `${patente}_${sello(fecha)}`);
  await fs.mkdir(carpeta, { recursive: true });
  const ctx = { patente, carpeta, timeoutMs: minutos * 60_000, anios: Math.max(1, Number(values.anios) || 10) };

  const interactivo = process.stdin.isTTY;
  const rl = interactivo ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
  let alSaltear = null;
  rl?.on('line', (l) => {
    if (alSaltear && /^s(altar|altear)?$/i.test(l.trim())) alSaltear();
  });

  console.log(`\nConsultando patente ${patente}…  (abriendo el navegador)`);
  const contexto = await abrirNavegador(values.navegador);
  const cerrarTodo = async () => {
    rl?.close();
    await contexto.close().catch(() => {});
  };
  rl?.on('SIGINT', async () => {
    console.log('\nCancelado.');
    await cerrarTodo();
    process.exit(130);
  });

  const porId = {};

  // 1) Lo que se puede consultar sin captcha (no necesita pestaña).
  for (const c of seleccion.filter((x) => x.sinCaptcha)) {
    console.log(`\n▶ ${c.titulo}  (vía sin captcha)`);
    try {
      const r = await c.sinCaptcha(contexto, ctx);
      if (r) {
        porId[c.id] = r;
        console.log('  ✔ Listo');
        continue;
      }
      console.log('  Respuesta no reconocida: se consulta en el navegador.');
    } catch (e) {
      console.log(`  No respondió (${e.message.split('\n')[0]}): se consulta en el navegador.`);
    }
  }

  // 2) El resto, en pestañas: se abren y completan en paralelo y después vamos de a una.
  const enPestana = seleccion.filter((c) => !porId[c.id]);
  const paginas = [];
  for (let i = 0; i < enPestana.length; i++) {
    paginas.push(i === 0 && contexto.pages()[0] ? contexto.pages()[0] : await contexto.newPage());
  }
  for (const [i, page] of paginas.entries()) {
    const c = enPestana[i];
    page.on('dialog', async (d) => {
      console.log(`  [${c.titulo}] El sitio dice: ${d.message()}`);
      await d.accept().catch(() => {});
    });
    page.on('download', async (d) => {
      const nombre = `${c.id}-${d.suggestedFilename()}`;
      await d.saveAs(path.join(carpeta, nombre)).catch(() => {});
      console.log(`  [${c.titulo}] Descargado: ${nombre}`);
    });
  }
  const errPreparar = await Promise.all(enPestana.map((c, i) => c.preparar(paginas[i], ctx).then(() => null, (e) => e)));

  for (const [i, c] of enPestana.entries()) {
    const page = paginas[i];
    console.log(`\n▶ ${c.titulo}  (captcha ${i + 1}/${enPestana.length})`);
    let r;
    let bloqueado = false;
    if (errPreparar[i]) {
      const cuerpo = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      bloqueado = /web page blocked|request rejected|access denied|forbidden|acceso denegado|bloquead/i.test(cuerpo);
      if (!bloqueado) {
        console.log(`  No pude completar el formulario automáticamente (${errPreparar[i].message.split('\n')[0]}).`);
        console.log(`  Completá la patente ${patente} a mano en la pestaña.`);
      }
    }
    if (bloqueado) {
      r = {
        estado: 'error',
        mensaje: 'El portal bloqueó el acceso (firewall del sitio). Probá más tarde, desde otra red o entrando a mano.',
      };
    } else if (page.isClosed()) {
      r = { estado: 'error', mensaje: 'La pestaña se cerró.' };
    } else {
      await page.bringToFront().catch(() => {});
      console.log(`  ${c.instrucciones}`);
      if (interactivo) console.log('  (para saltear este portal: "s" + Enter)');
      const estado = { terminado: false, envios: 0 };
      const salteo = new Promise((res) => {
        alSaltear = () => res({ estado: 'error', mensaje: 'Salteado.' });
      });
      try {
        r = await Promise.race([c.esperar(page, ctx, estado), salteo]);
      } catch (e) {
        r = {
          estado: 'error',
          mensaje:
            e.name === 'TimeoutError'
              ? `Pasaron ${minutos} min sin resultado.`
              : /closed/i.test(e.message)
                ? 'Se cerró la pestaña o el navegador.'
                : e.message.split('\n')[0],
        };
      } finally {
        estado.terminado = true;
        alSaltear = null;
      }
    }
    if (!page.isClosed()) {
      r.url = page.url();
      const captura = `${c.id}.png`;
      try {
        await page.screenshot({ path: path.join(carpeta, captura), fullPage: true });
        r.captura = captura;
      } catch {}
    }
    console.log(r.estado === 'ok' ? '  ✔ Listo' : `  ✖ ${r.mensaje}`);
    porId[c.id] = r;
  }

  const resultados = seleccion.map((c) => ({ ...porId[c.id], id: c.id, titulo: c.titulo }));
  const resumen = armarResumen(patente, fecha, resultados, carpeta);
  await fs.writeFile(path.join(carpeta, 'resumen.md'), resumen + '\n');
  const sinTexto = resultados.map(({ texto: _t, ...resto }) => resto);
  await fs.writeFile(path.join(carpeta, 'datos.json'), JSON.stringify({ patente, fecha, resultados: sinTexto }, null, 2));
  console.log(`\n${'─'.repeat(60)}\n${resumen}\n${'─'.repeat(60)}`);

  if (interactivo && !values.cerrar) {
    await new Promise((res) => rl.question('\nEnter para cerrar el navegador… ', res));
  }
  await cerrarTodo();
}

const esPrincipal = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('consulta-patente.mjs');
if (esPrincipal) {
  main().catch((e) => {
    console.error(`\nError: ${e.message}`);
    process.exit(1);
  });
}
