// Explicit import: this module is also rendered outside Next's compiler
// (scripts, tests), where the automatic JSX runtime is not configured.
import React from 'react';
import path from 'node:path';
import {
  Document,
  Font,
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
} from '@react-pdf/renderer';
import { VIXART } from '@/lib/vixart';
import { amountInWords } from '@/lib/amount-in-words';
import { formatMAD, formatRate, fromMillis, lineTotal } from '@/lib/money';
import { DOCUMENT_TITLE_FR } from '@/lib/labels';

/**
 * A4 quote / invoice / credit note.
 *
 * Inter is registered from files committed to the repo. @react-pdf falls back
 * to Helvetica when no font is registered, and Helvetica is banned by the brand
 * standard — a silent substitution here would put the wrong typeface on every
 * document the agency sends.
 *
 * The document itself is in French: it is a legal document issued in Morocco to
 * Moroccan clients, and its wording is not an interface language choice.
 */

const FONT_DIR = path.join(process.cwd(), 'src/assets/fonts');

Font.register({
  family: 'Inter',
  fonts: [
    { src: path.join(FONT_DIR, 'Inter-400.ttf'), fontWeight: 400 },
    { src: path.join(FONT_DIR, 'Inter-500.ttf'), fontWeight: 500 },
    { src: path.join(FONT_DIR, 'Inter-600.ttf'), fontWeight: 600 },
    { src: path.join(FONT_DIR, 'Inter-700.ttf'), fontWeight: 700 },
  ],
});

// Stops long client names and service labels breaking mid-word.
Font.registerHyphenationCallback((word: string) => [word]);

const VOID = '#0B0B0F';

const s = StyleSheet.create({
  page: {
    fontFamily: 'Inter',
    fontSize: 9,
    color: VOID,
    paddingTop: 40,
    paddingBottom: 64,
    paddingHorizontal: 44,
    lineHeight: 1.45,
  },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between' },
  brand: { fontSize: 18, fontWeight: 700, letterSpacing: -0.4 },
  small: { fontSize: 8, opacity: 0.72 },
  meta: { fontSize: 8, opacity: 0.55 },
  docTitle: { fontSize: 22, fontWeight: 700, letterSpacing: -0.5, textAlign: 'right' },
  docNumber: { fontSize: 11, fontWeight: 600, textAlign: 'right', marginTop: 2 },
  rule: { borderBottomWidth: 1.5, borderBottomColor: VOID, marginTop: 14, marginBottom: 16 },
  hairline: { borderBottomWidth: 0.5, borderBottomColor: VOID, opacity: 0.25 },
  blocks: { flexDirection: 'row', justifyContent: 'space-between', gap: 24 },
  block: { width: '48%' },
  blockTitle: { fontSize: 7.5, fontWeight: 600, letterSpacing: 0.5, opacity: 0.55, marginBottom: 4 },
  strong: { fontWeight: 600 },
  tableHead: {
    flexDirection: 'row',
    borderBottomWidth: 1.5,
    borderBottomColor: VOID,
    paddingBottom: 5,
    marginTop: 24,
  },
  row: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderBottomColor: VOID,
    paddingVertical: 6,
  },
  cDesc: { width: '46%' },
  cUnit: { width: '14%', textAlign: 'right' },
  cQty: { width: '12%', textAlign: 'right' },
  cPrice: { width: '14%', textAlign: 'right' },
  cTotal: { width: '14%', textAlign: 'right' },
  th: { fontSize: 7.5, fontWeight: 600, letterSpacing: 0.4, opacity: 0.6 },
  totals: { marginTop: 18, marginLeft: 'auto', width: '52%' },
  tRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3.5 },
  tGrand: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    borderTopWidth: 1.5,
    borderTopColor: VOID,
    marginTop: 4,
  },
  grandLabel: { fontSize: 11, fontWeight: 700 },
  grandValue: { fontSize: 13, fontWeight: 700 },
  footer: {
    position: 'absolute',
    bottom: 28,
    left: 44,
    right: 44,
    borderTopWidth: 0.5,
    borderTopColor: VOID,
    paddingTop: 8,
    fontSize: 7,
    opacity: 0.6,
    textAlign: 'center',
  },
  note: { marginTop: 18, fontSize: 8, opacity: 0.75 },

  // The total in words. Boxed, because it is the line a reader checks the
  // figures against — brand law allows a border, never a colour.
  arretee: {
    marginTop: 16,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: '#0B0B0F',
    paddingVertical: 7,
    fontSize: 9,
  },

  // Somewhere for the client to sign a quote back.
  accord: { marginTop: 26 },
  accordBox: {
    marginTop: 6,
    height: 66,
    borderWidth: 1,
    borderColor: '#0B0B0F',
    borderStyle: 'dashed',
  },
});

export interface PdfLine {
  label: string;
  unit: string;
  unitPriceCentimes: bigint;
  quantityMillis: bigint;
}

export interface PdfInput {
  docType: string;
  number: string;
  issueDate: string | null;
  dueDate: string | null;
  clientName: string;
  clientLegalName: string | null;
  clientIce: string | null;
  clientIf: string | null;
  clientAddress: string | null;
  subject: string | null;
  notes: string | null;
  paymentTerms: string | null;
  vatRateBp: number;
  vatExemptionReason: string | null;
  withholding: boolean;
  withholdingRateBp: number;
  discountCentimes: bigint;
  totalExclVat: bigint;
  totalVat: bigint;
  totalInclVat: bigint;
  withheld: bigint;
  netToCollect: bigint;
  lines: PdfLine[];
}

const UNIT_FR: Record<string, string> = {
  forfait: 'Forfait',
  mois: 'Mois',
  jour: 'Jour',
};

function frDate(iso: string | null): string {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

export async function renderDocumentPdf(input: PdfInput): Promise<Buffer> {
  const title = DOCUMENT_TITLE_FR[input.docType] ?? 'DOCUMENT';
  const subtotal = input.totalExclVat + input.discountCentimes;

  const doc = (
    <Document
      title={`${title} ${input.number}`}
      author={VIXART.legalName}
      subject={input.subject ?? undefined}
    >
      <Page size="A4" style={s.page}>
        {/* --- Issuer and document identity ------------------------------- */}
        <View style={s.headerRow}>
          <View style={{ width: '55%' }}>
            <Text style={s.brand}>VIXART</Text>
            <Text style={[s.small, { marginTop: 4, fontWeight: 600 }]}>
              {VIXART.legalName}
            </Text>
            <Text style={s.small}>{VIXART.activity}</Text>
            <Text style={s.small}>{VIXART.address}</Text>
            <Text style={[s.meta, { marginTop: 4 }]}>{VIXART.rc}</Text>
            <Text style={s.meta}>
              ICE {VIXART.ice} · IF {VIXART.taxId}
            </Text>
            {/* Printed only once the real values are on file. See lib/vixart.ts. */}
            {(VIXART.taxeProfessionnelle || VIXART.cnss) && (
              <Text style={s.meta}>
                {[
                  VIXART.taxeProfessionnelle && `TP ${VIXART.taxeProfessionnelle}`,
                  VIXART.cnss && `CNSS ${VIXART.cnss}`,
                ].filter(Boolean).join(' · ')}
              </Text>
            )}
            {VIXART.capitalSocial && (
              <Text style={s.meta}>Capital social : {VIXART.capitalSocial}</Text>
            )}
          </View>
          <View style={{ width: '40%' }}>
            <Text style={s.docTitle}>{title}</Text>
            <Text style={s.docNumber}>{input.number}</Text>
            <Text style={[s.small, { textAlign: 'right', marginTop: 6 }]}>
              Date : {frDate(input.issueDate)}
            </Text>
            {input.dueDate && (
              <Text style={[s.small, { textAlign: 'right' }]}>
                Échéance : {frDate(input.dueDate)}
              </Text>
            )}
          </View>
        </View>

        <View style={s.rule} />

        {/* --- Client, as frozen at issue --------------------------------- */}
        <View style={s.blocks}>
          <View style={s.block}>
            <Text style={s.blockTitle}>CLIENT</Text>
            <Text style={s.strong}>{input.clientLegalName ?? input.clientName}</Text>
            {input.clientLegalName && input.clientLegalName !== input.clientName && (
              <Text style={s.small}>{input.clientName}</Text>
            )}
            {input.clientAddress && <Text style={s.small}>{input.clientAddress}</Text>}
            {input.clientIce && <Text style={s.meta}>ICE {input.clientIce}</Text>}
            {input.clientIf && <Text style={s.meta}>IF {input.clientIf}</Text>}
          </View>
          {input.subject && (
            <View style={s.block}>
              <Text style={s.blockTitle}>OBJET</Text>
              <Text>{input.subject}</Text>
            </View>
          )}
        </View>

        {/* --- Lines ------------------------------------------------------- */}
        <View style={s.tableHead}>
          <Text style={[s.th, s.cDesc]}>DÉSIGNATION</Text>
          <Text style={[s.th, s.cUnit]}>UNITÉ</Text>
          <Text style={[s.th, s.cQty]}>QTÉ</Text>
          <Text style={[s.th, s.cPrice]}>P.U. HT</Text>
          <Text style={[s.th, s.cTotal]}>TOTAL HT</Text>
        </View>

        {input.lines.map((line, i) => (
          <View key={i} style={s.row} wrap={false}>
            <Text style={s.cDesc}>{line.label}</Text>
            <Text style={s.cUnit}>{UNIT_FR[line.unit] ?? line.unit}</Text>
            <Text style={s.cQty}>{fromMillis(line.quantityMillis)}</Text>
            <Text style={s.cPrice}>{formatMAD(line.unitPriceCentimes)}</Text>
            <Text style={[s.cTotal, s.strong]}>
              {formatMAD(lineTotal(line.unitPriceCentimes, line.quantityMillis))}
            </Text>
          </View>
        ))}

        {/* --- Totals ------------------------------------------------------ */}
        <View style={s.totals}>
          {input.discountCentimes > 0n && (
            <>
              <View style={s.tRow}>
                <Text>Sous-total HT</Text>
                <Text>{formatMAD(subtotal)}</Text>
              </View>
              <View style={s.tRow}>
                <Text>Remise</Text>
                <Text>− {formatMAD(input.discountCentimes)}</Text>
              </View>
              <View style={s.hairline} />
            </>
          )}
          <View style={s.tRow}>
            <Text>Total HT</Text>
            <Text style={s.strong}>{formatMAD(input.totalExclVat)}</Text>
          </View>
          <View style={s.tRow}>
            <Text>TVA {formatRate(input.vatRateBp)}</Text>
            <Text>{formatMAD(input.totalVat)}</Text>
          </View>
          <View style={s.tGrand}>
            <Text style={s.grandLabel}>Total TTC</Text>
            <Text style={s.grandValue}>{formatMAD(input.totalInclVat)}</Text>
          </View>

          {input.withholding && input.withheld > 0n && (
            <>
              <View style={s.tRow}>
                <Text>
                  Retenue à la source {formatRate(input.withholdingRateBp)}
                </Text>
                <Text>− {formatMAD(input.withheld)}</Text>
              </View>
              <View style={s.tGrand}>
                <Text style={s.grandLabel}>Net à encaisser</Text>
                <Text style={s.grandValue}>{formatMAD(input.netToCollect)}</Text>
              </View>
            </>
          )}
        </View>

        {/*
          The total written out. Moroccan invoices carry this, and it is what
          makes the figure hard to alter after the fact: a digit can be changed
          with a pen, a sentence cannot.

          It states the TTC — the amount the document is for. Where a
          withholding applies, the net actually collected is a consequence of
          that figure, not a different total, so it is named separately rather
          than replacing it.
        */}
        <View style={s.arretee}>
          <Text>
            {input.docType === 'devis'
              ? 'Arrêté le présent devis à la somme de : '
              : input.docType === 'avoir'
                ? 'Arrêté le présent avoir à la somme de : '
                : 'Arrêtée la présente facture à la somme de : '}
            <Text style={s.strong}>{amountInWords(input.totalInclVat)}</Text>
            {' TTC.'}
          </Text>
          {input.withholding && input.withheld > 0n && (
            <Text style={{ marginTop: 3 }}>
              Net à encaisser après retenue à la source :{' '}
              <Text style={s.strong}>{amountInWords(input.netToCollect)}</Text>.
            </Text>
          )}
        </View>

        {input.vatRateBp === 0 && input.vatExemptionReason && (
          <Text style={s.note}>
            Exonération de TVA : {input.vatExemptionReason}
          </Text>
        )}
        {input.withholding && (
          <Text style={s.note}>
            Retenue à la source sur la TVA appliquée conformément à l’article 117 bis
            du Code Général des Impôts.
          </Text>
        )}
        {input.paymentTerms && (
          <Text style={s.note}>Conditions de règlement : {input.paymentTerms}</Text>
        )}
        {input.notes && <Text style={s.note}>{input.notes}</Text>}

        {input.docType === 'devis' && (
          <>
            <Text style={s.note}>
              {input.dueDate
                ? `Offre valable jusqu'au ${frDate(input.dueDate)}.`
                : 'Offre valable 30 jours à compter de la date ci-dessus.'}
              {' '}Les prix sont exprimés en dirhams marocains.
            </Text>
            {/* A quote becomes an agreement when the client signs it. */}
            <View style={s.accord} wrap={false}>
              <Text style={s.blockTitle}>BON POUR ACCORD</Text>
              <Text style={s.meta}>
                Date, cachet et signature du client, précédés de la mention
                « Bon pour accord »
              </Text>
              <View style={s.accordBox} />
            </View>
          </>
        )}

        <Text style={s.footer} fixed>
          {VIXART.legalName} · {VIXART.activity} · {VIXART.address} ·{' '}
          {VIXART.rc} · ICE {VIXART.ice} · IF {VIXART.taxId}
        </Text>
      </Page>
    </Document>
  );

  return renderToBuffer(doc);
}
