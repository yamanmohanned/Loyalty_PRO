import { useEffect } from 'react';
import { I18nManager, ScrollView, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { formatIqd } from '@walaa/shared-types';
import { theme } from './src/theme';

/**
 * Phase 0 foundation smoke screen for the assistant app.
 *
 * RTL is forced at the root before any screen renders (CLAUDE.md §0.3). React Native
 * does not mirror by default the way a browser does — `allowRTL` + `forceRTL` make
 * every flex row, every text alignment and every navigation transition right-to-left
 * for the whole app, regardless of the device's own locale. Doing this per-screen is
 * exactly the mistake this file exists to prevent.
 *
 * Note: a forceRTL change only takes effect after a reload. Calling it at module
 * scope means it is already applied on the very first render of a fresh install.
 *
 * Phase 3 replaces this screen with the real core loop.
 */

I18nManager.allowRTL(true);
I18nManager.forceRTL(true);

const TIERS = [
  { threshold: 100_000, discount: 5 },
  { threshold: 250_000, discount: 10 },
  { threshold: 500_000, discount: 15 },
];

export default function App() {
  useEffect(() => {
    if (!I18nManager.isRTL) {
      // Surfaces the one case the root call cannot fix by itself: a running app that
      // was installed before RTL was forced and has not been reloaded yet.
      console.warn('RTL غير مفعّل بعد — أعد تحميل التطبيق لتطبيق الاتجاه.');
    }
  }, []);

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.tagline}>منصة ولاء ومكافآت السوبرماركت</Text>
        <Text style={styles.title}>ولاء — مساعد الكاشير</Text>
        <Text style={styles.body}>
          الأساس جاهز. الاتجاه من اليمين إلى اليسار مفعّل من جذر التطبيق.
        </Text>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>مستويات الولاء الافتراضية</Text>
          {TIERS.map((tier) => (
            <View key={tier.threshold} style={styles.tierRow}>
              <Text style={styles.amount}>{formatIqd(tier.threshold)}</Text>
              <View style={styles.chip}>
                <Text style={styles.chipText}>خصم {tier.discount}٪</Text>
              </View>
            </View>
          ))}
        </View>

        <Text style={styles.caption}>
          الحالة: {I18nManager.isRTL ? 'RTL مفعّل' : 'RTL غير مفعّل — أعد التحميل'}
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: theme.colors.canvas,
  },
  content: {
    padding: theme.spacing.lg,
    paddingTop: theme.spacing.xxl,
    gap: theme.spacing.sm,
  },
  tagline: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.steel,
  },
  title: {
    fontSize: theme.fontSize.xxl,
    fontWeight: '700',
    color: theme.colors.ink,
  },
  body: {
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.6,
    color: theme.colors.steel,
    marginTop: theme.spacing.sm,
  },
  card: {
    marginTop: theme.spacing.lg,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.md,
  },
  cardTitle: {
    fontSize: theme.fontSize.lg,
    fontWeight: '600',
    color: theme.colors.ink,
    marginBottom: theme.spacing.sm,
  },
  tierRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: theme.spacing.md,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  amount: {
    fontSize: theme.fontSize.lg,
    fontWeight: '700',
    color: theme.colors.ink,
    // fontVariant keeps digits aligned until the IBM Plex Mono face is bundled in Phase 3.
    fontVariant: ['tabular-nums'],
  },
  chip: {
    backgroundColor: theme.colors.accentTint,
    borderRadius: theme.radius.pill,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs,
  },
  chipText: {
    color: theme.colors.accent,
    fontSize: theme.fontSize.sm,
    fontWeight: '600',
  },
  caption: {
    marginTop: theme.spacing.lg,
    fontSize: theme.fontSize.sm,
    color: theme.colors.steel,
  },
});
