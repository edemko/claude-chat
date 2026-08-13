import 'package:flutter/material.dart';

/// Palette tokens shared with the PWA, so both clients look like one product.
///
/// Two accent hues carry emphasis: warm for bold, cool for italic. Each has a
/// second variant for use inside the filled iris bubble, where the saturated
/// background needs the opposite lightness to stay legible.
@immutable
class CcColors extends ThemeExtension<CcColors> {
  const CcColors({
    required this.ink,
    required this.panel,
    required this.raised,
    required this.line,
    required this.text,
    required this.muted,
    required this.you,
    required this.onYou,
    required this.live,
    required this.ok,
    required this.warn,
    required this.bad,
    required this.strong,
    required this.em,
    required this.strongOnYou,
    required this.emOnYou,
    required this.codeBg,
  });

  final Color ink;
  final Color panel;
  final Color raised;
  final Color line;
  final Color text;
  final Color muted;
  final Color you;
  final Color onYou;
  final Color live;
  final Color ok;
  final Color warn;
  final Color bad;
  final Color strong;
  final Color em;
  final Color strongOnYou;
  final Color emOnYou;
  final Color codeBg;

  static const light = CcColors(
    ink: Color(0xFFF6F8FC),
    panel: Color(0xFFFFFFFF),
    raised: Color(0xFFE9EDF4),
    line: Color(0xFFD7DDE8),
    text: Color(0xFF151A22),
    muted: Color(0xFF59647A),
    you: Color(0xFF3A54D8),
    onYou: Color(0xFFFFFFFF),
    live: Color(0xFFD9481C),
    ok: Color(0xFF0F7A5A),
    warn: Color(0xFF8A5A00),
    bad: Color(0xFFC02626),
    strong: Color(0xFF8A4B00),
    em: Color(0xFF0A5F80),
    strongOnYou: Color(0xFFFFDF8A),
    emOnYou: Color(0xFFD3DDFF),
    codeBg: Color(0x14141A26),
  );

  static const dark = CcColors(
    ink: Color(0xFF0F1219),
    panel: Color(0xFF161B24),
    raised: Color(0xFF1E2530),
    line: Color(0xFF262E3B),
    text: Color(0xFFE4E8F0),
    muted: Color(0xFF7F8A9E),
    you: Color(0xFF6E8BFF),
    onYou: Color(0xFF0A0E1A),
    live: Color(0xFFFF8A5B),
    ok: Color(0xFF4FD1A5),
    warn: Color(0xFFFFC552),
    bad: Color(0xFFFF6B6B),
    strong: Color(0xFFFFD479),
    em: Color(0xFF7FD4FF),
    strongOnYou: Color(0xFF4A2400),
    emOnYou: Color(0xFF10214F),
    codeBg: Color(0x12FFFFFF),
  );

  @override
  CcColors copyWith() => this;

  @override
  CcColors lerp(ThemeExtension<CcColors>? other, double t) {
    if (other is! CcColors) return this;
    return CcColors(
      ink: Color.lerp(ink, other.ink, t)!,
      panel: Color.lerp(panel, other.panel, t)!,
      raised: Color.lerp(raised, other.raised, t)!,
      line: Color.lerp(line, other.line, t)!,
      text: Color.lerp(text, other.text, t)!,
      muted: Color.lerp(muted, other.muted, t)!,
      you: Color.lerp(you, other.you, t)!,
      onYou: Color.lerp(onYou, other.onYou, t)!,
      live: Color.lerp(live, other.live, t)!,
      ok: Color.lerp(ok, other.ok, t)!,
      warn: Color.lerp(warn, other.warn, t)!,
      bad: Color.lerp(bad, other.bad, t)!,
      strong: Color.lerp(strong, other.strong, t)!,
      em: Color.lerp(em, other.em, t)!,
      strongOnYou: Color.lerp(strongOnYou, other.strongOnYou, t)!,
      emOnYou: Color.lerp(emOnYou, other.emOnYou, t)!,
      codeBg: Color.lerp(codeBg, other.codeBg, t)!,
    );
  }
}

/// Monospace stack for machine facts: paths, pane ids, tool names, code.
const monoFamily = 'monospace';

ThemeData buildTheme(Brightness brightness) {
  final cc = brightness == Brightness.dark ? CcColors.dark : CcColors.light;

  return ThemeData(
    brightness: brightness,
    scaffoldBackgroundColor: cc.ink,
    colorScheme: ColorScheme.fromSeed(
      seedColor: cc.you,
      brightness: brightness,
    ).copyWith(surface: cc.ink, primary: cc.you),
    extensions: [cc],
    dividerColor: cc.line,
    appBarTheme: AppBarTheme(
      backgroundColor: cc.ink,
      surfaceTintColor: Colors.transparent,
      foregroundColor: cc.text,
      elevation: 0,
      scrolledUnderElevation: 0,
      shape: Border(bottom: BorderSide(color: cc.line)),
      titleTextStyle: TextStyle(
        color: cc.text,
        fontSize: 19,
        fontWeight: FontWeight.w600,
        letterSpacing: -0.3,
      ),
    ),
    textTheme: Typography.material2021(platform: TargetPlatform.android)
        .black
        .apply(bodyColor: cc.text, displayColor: cc.text),
    bottomSheetTheme: BottomSheetThemeData(
      backgroundColor: cc.ink,
      surfaceTintColor: Colors.transparent,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
      ),
    ),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: cc.raised,
      contentTextStyle: TextStyle(color: cc.text, fontSize: 13.5),
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(11),
        side: BorderSide(color: cc.line),
      ),
    ),
    switchTheme: SwitchThemeData(
      thumbColor: WidgetStateProperty.resolveWith(
        (s) => s.contains(WidgetState.selected) ? cc.you : cc.muted,
      ),
    ),
    progressIndicatorTheme: ProgressIndicatorThemeData(color: cc.you),
  );
}

/// Convenience accessor: `context.cc.strong`.
extension CcTheme on BuildContext {
  CcColors get cc => Theme.of(this).extension<CcColors>() ?? CcColors.dark;
}
