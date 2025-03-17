import * as pdfLib from '@pdfme/pdf-lib';
import type { Font as FontKitFont } from 'fontkit';
import type { TextSchema } from './types.js';
import {
  PDFRenderProps,
  ColorType,
  Font,
  getDefaultFont,
  getFallbackFontName,
  mm2pt,
} from '@pdfme/common';
import {
  VERTICAL_ALIGN_TOP,
  VERTICAL_ALIGN_MIDDLE,
  VERTICAL_ALIGN_BOTTOM,
  DEFAULT_FONT_SIZE,
  DEFAULT_ALIGNMENT,
  DEFAULT_VERTICAL_ALIGNMENT,
  DEFAULT_LINE_HEIGHT,
  DEFAULT_CHARACTER_SPACING,
  DEFAULT_FONT_COLOR,
} from './constants.js';
import {
  calculateDynamicFontSize,
  heightOfFontAtSize,
  getFontDescentInPt,
  getFontKitFont,
  widthOfTextAtSize,
  splitTextToSize,
} from './helper.js';
import { convertForPdfLayoutProps, rotatePoint, hex2PrintingColor } from '../utils.js';

const embedAndGetFontObj = async (arg: {
  pdfDoc: any;
  font: Font;
  _cache: Map<any, any>;
}) => {
  const { pdfDoc, font, _cache } = arg;
  if (_cache.has(pdfDoc)) {
    return _cache.get(pdfDoc) as { [key: string]: any };
  }

  const fontValues = await Promise.all(
    Object.values(font).map(async (v: any) => {
      let fontData = v.data;
      if (typeof fontData === 'string' && fontData.startsWith('http')) {
        fontData = await fetch(fontData).then((res) => res.arrayBuffer());
      }
      return pdfDoc.embedFont(fontData, {
        subset: typeof v.subset === 'undefined' ? true : v.subset,
      });
    })
  );

  const fontObj = Object.keys(font).reduce(
    (acc, cur, i) => Object.assign(acc, { [cur]: fontValues[i] }),
    {} as { [key: string]: any }
  );

  _cache.set(pdfDoc, fontObj);
  return fontObj;
};

const getFontProp = ({
  value,
  fontKitFont,
  schema,
  colorType,
}: {
  value: string;
  fontKitFont: FontKitFont;
  colorType?: ColorType;
  schema: TextSchema;
}) => {
  const fontSize = schema.dynamicFontSize
    ? calculateDynamicFontSize({ textSchema: schema, fontKitFont, value })
    : schema.fontSize ?? DEFAULT_FONT_SIZE;
  const color = hex2PrintingColor(schema.fontColor || DEFAULT_FONT_COLOR, colorType);

  return {
    alignment: schema.alignment ?? DEFAULT_ALIGNMENT,
    verticalAlignment: schema.verticalAlignment ?? DEFAULT_VERTICAL_ALIGNMENT,
    lineHeight: schema.lineHeight ?? DEFAULT_LINE_HEIGHT,
    characterSpacing: schema.characterSpacing ?? DEFAULT_CHARACTER_SPACING,
    fontSize,
    color,
  };
};

export const pdfRender = async (arg: PDFRenderProps<TextSchema>) => {
  const { value, pdfDoc, pdfLib, page, options, schema, _cache } = arg;
  if (!value) return;

  const { font = getDefaultFont(), colorType } = options;

  const pdfFontObj = await embedAndGetFontObj({ pdfDoc, font, _cache });
  
  const fontName = (
    schema.fontName ? schema.fontName : getFallbackFontName(font)
  ) as keyof typeof pdfFontObj;
  const pdfFontValue = pdfFontObj && pdfFontObj[fontName];
  
  console.log('Primary font:', fontName);
  
  const fallbackFontNames = (schema as any)._fontFallbackString 
    ? (schema as any)._fontFallbackString.split(',').map((f: string) => f.trim())
    : [];
  
  console.log('Fallback font names:', fallbackFontNames);
  
  const fallbackPdfFonts: any[] = [];

  for (const fallbackName of fallbackFontNames) {
    if (pdfFontObj[fallbackName]) {
      fallbackPdfFonts.push(pdfFontObj[fallbackName]);
      console.log('Found fallback font:', fallbackName);
    } else {
      console.log('Missing fallback font:', fallbackName);
    }
  }
  
  if (fallbackPdfFonts.length === 0 && pdfFontObj['Roboto']) {
    fallbackPdfFonts.push(pdfFontObj['Roboto']);
    console.log('Using Roboto as fallback font');
  }
  
  console.log('Available fonts:', Object.keys(pdfFontObj));
  
  const fontKitFont = await getFontKitFont(schema.fontName, font, _cache);
  const fontProp = getFontProp({ value, fontKitFont, schema, colorType });

  const { fontSize, color, alignment, verticalAlignment, lineHeight, characterSpacing } = fontProp;

  const pageHeight = page.getHeight();
  const {
    width,
    height,
    rotate,
    position: { x, y },
    opacity,
  } = convertForPdfLayoutProps({ schema, pageHeight, applyRotateTranslate: false });

  if (schema.backgroundColor) {
    const color = hex2PrintingColor(schema.backgroundColor, colorType);
    page.drawRectangle({ x, y, width, height, rotate, color });
  }

  const firstLineTextHeight = heightOfFontAtSize(fontKitFont, fontSize);
  const descent = getFontDescentInPt(fontKitFont, fontSize);
  const halfLineHeightAdjustment = lineHeight === 0 ? 0 : ((lineHeight - 1) * fontSize) / 2;

  const lines = splitTextToSize({
    value,
    characterSpacing,
    fontSize,
    fontKitFont,
    boxWidthInPt: width,
  });

  let yOffset = 0;
  if (verticalAlignment === VERTICAL_ALIGN_TOP) {
    yOffset = firstLineTextHeight + halfLineHeightAdjustment;
  } else {
    const otherLinesHeight = lineHeight * fontSize * (lines.length - 1);

    if (verticalAlignment === VERTICAL_ALIGN_BOTTOM) {
      yOffset = height - otherLinesHeight + descent - halfLineHeightAdjustment;
    } else if (verticalAlignment === VERTICAL_ALIGN_MIDDLE) {
      yOffset =
        (height - otherLinesHeight - firstLineTextHeight + descent) / 2 + firstLineTextHeight;
    }
  }

  const pivotPoint = { 
    x: x + width / 2, 
    y: pageHeight - mm2pt((schema as any).position.y) - height / 2 
  };
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

  const isCharSupportedByFont = (char: string, font: FontKitFont): boolean => {
    try {
      return font.hasGlyphForCodePoint(char.codePointAt(0) || 0);
    } catch (e) {
      return false;
    }
  };

  lines.forEach((line, rowIndex) => {
    const trimmed = line.replace('\n', '');
    const textWidth = widthOfTextAtSize(trimmed, fontKitFont, fontSize, characterSpacing);
    const textHeight = heightOfFontAtSize(fontKitFont, fontSize);
    const rowYOffset = lineHeight * fontSize * rowIndex;

    if (line === '') {
      line = '\r\n';
    }

    let xLine = x;
    if (alignment === 'center') {
      xLine += (width - textWidth) / 2;
    } else if (alignment === 'right') {
      xLine += width - textWidth;
    }

    let yLine = pageHeight - mm2pt((schema as any).position.y) - yOffset - rowYOffset;

    if (schema.strikethrough && textWidth > 0) {
      const _x = xLine + textWidth + 1;
      const _y = yLine + textHeight / 3;
      page.drawLine({
        start: rotatePoint({ x: xLine, y: _y }, pivotPoint, rotate.angle),
        end: rotatePoint({ x: _x, y: _y }, pivotPoint, rotate.angle),
        thickness: (1 / 12) * fontSize,
        color: color,
        opacity,
      });
    }

    if (schema.underline && textWidth > 0) {
      const _x = xLine + textWidth + 1;
      const _y = yLine - textHeight / 12;
      page.drawLine({
        start: rotatePoint({ x: xLine, y: _y }, pivotPoint, rotate.angle),
        end: rotatePoint({ x: _x, y: _y }, pivotPoint, rotate.angle),
        thickness: (1 / 12) * fontSize,
        color: color,
        opacity,
      });
    }

    if (rotate.angle !== 0) {
      const rotatedPoint = rotatePoint({ x: xLine, y: yLine }, pivotPoint, rotate.angle);
      xLine = rotatedPoint.x;
      yLine = rotatedPoint.y;
    }

    let spacing = characterSpacing;
    if (alignment === 'justify' && line.slice(-1) !== '\n') {
      const iterator = segmenter.segment(trimmed)[Symbol.iterator]();
      const len = Array.from(iterator).length;
      spacing += (width - textWidth) / len;
    }
    page.pushOperators((pdfLib as any).setCharacterSpacing(spacing));

    if (fallbackPdfFonts.length > 0) {
      const segments: { text: string; font: any }[] = [];
      let currentSegment = '';
      let currentFont = pdfFontValue;
      
      for (const char of trimmed) {
        const isAsciiChar = char.charCodeAt(0) < 128;
        
        if (isAsciiChar && fallbackPdfFonts.length > 0) {
          if (currentSegment) {
            segments.push({ text: currentSegment, font: currentFont });
            currentSegment = '';
          }
          
          currentFont = fallbackPdfFonts[0];
          currentSegment = char;
          console.log(`ASCII character '${char}' using fallback font`);
        } else if (isCharSupportedByFont(char, fontKitFont)) {
          if (currentFont !== pdfFontValue && currentSegment) {
            segments.push({ text: currentSegment, font: currentFont });
            currentSegment = '';
            currentFont = pdfFontValue;
          }
          
          currentSegment += char;
          console.log(`Supported character '${char}' using primary font`);
        } else {
          if (currentSegment) {
            segments.push({ text: currentSegment, font: currentFont });
            currentSegment = '';
          }
          
          if (fallbackPdfFonts.length > 0) {
            currentFont = fallbackPdfFonts[0];
            currentSegment = char;
            console.log(`Unsupported character '${char}' using fallback font`);
          } else {
            currentFont = pdfFontValue;
            currentSegment = char;
            console.log(`Unsupported character '${char}' using primary font (no fallback available)`);
          }
        }
      }
      
      if (currentSegment) {
        segments.push({ text: currentSegment, font: currentFont });
      }
      
      let currentX = xLine;
      for (const segment of segments) {
        try {
          // Debug log for rendering segment
          console.log(`Rendering segment: '${segment.text}' with font`);
          
          page.drawText(segment.text, {
            x: currentX,
            y: yLine,
            rotate,
            size: fontSize,
            color,
            lineHeight: lineHeight * fontSize,
            font: segment.font,
            opacity,
          });
          
          // Move the x position for the next segment
          currentX += segment.font.widthOfTextAtSize(segment.text, fontSize);
        } catch (e) {
          console.error('Error rendering text segment:', e);
          // If there's an error, try with the primary font
          try {
            // Debug log for fallback rendering
            console.log(`Fallback rendering segment: '${segment.text}' with primary font`);
            
            page.drawText(segment.text, {
              x: currentX,
              y: yLine,
              rotate,
              size: fontSize,
              color,
              lineHeight: lineHeight * fontSize,
              font: pdfFontValue,
              opacity,
            });
            
            // Move the x position for the next segment
            currentX += pdfFontValue.widthOfTextAtSize(segment.text, fontSize);
          } catch (e2) {
            console.error('Error rendering text segment with primary font:', e2);
          }
        }
      }
    } else {
      page.drawText(trimmed, {
        x: xLine,
        y: yLine,
        rotate,
        size: fontSize,
        color,
        lineHeight: lineHeight * fontSize,
        font: pdfFontValue,
        opacity,
      });
    }
  });
};
