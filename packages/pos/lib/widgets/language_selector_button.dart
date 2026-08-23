import 'package:flutter/material.dart';
import '../i18n/i18n_service.dart';

/// Button that displays current language and opens language switcher dialog.
class LanguageSelectorButton extends StatelessWidget {
  const LanguageSelectorButton({
    super.key,
    this.iconOnly = false,
    this.textColor,
  });

  final bool iconOnly;
  final Color? textColor;

  static Future<void> showLanguageDialog(BuildContext context) async {
    final i18n = I18nService.instance;
    await showDialog(
      context: context,
      builder: (ctx) {
        return AlertDialog(
          title: Row(
            children: [
              const Icon(Icons.language, size: 24),
              const SizedBox(width: 8),
              Text(tr('common.selectLanguage')),
            ],
          ),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: I18nService.supportedLocales.entries.map((entry) {
              final isSelected = entry.key == i18n.currentLocale;
              return ListTile(
                title: Text(entry.value),
                subtitle: Text(entry.key.toUpperCase()),
                trailing: isSelected
                    ? Icon(Icons.check_circle,
                        color: Theme.of(ctx).colorScheme.primary)
                    : null,
                selected: isSelected,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(8),
                ),
                onTap: () {
                  i18n.setLocale(entry.key);
                  Navigator.of(ctx).pop();
                },
              );
            }).toList(),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: Text(tr('common.close')),
            ),
          ],
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final i18n = I18nService.instance;
    if (iconOnly) {
      return IconButton(
        tooltip: tr('common.language'),
        icon: const Icon(Icons.language),
        onPressed: () => showLanguageDialog(context),
      );
    }

    return TextButton.icon(
      style: TextButton.styleFrom(
        foregroundColor: textColor,
      ),
      icon: const Icon(Icons.language, size: 18),
      label: Text(i18n.currentLocaleName),
      onPressed: () => showLanguageDialog(context),
    );
  }
}
