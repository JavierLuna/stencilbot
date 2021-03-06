import { contain, cover, IntrinsicScale } from 'intrinsic-scale';
import { Layer, ImageFit, TextAlign, VerticalAlign, RepeatPattern } from './Layer';
import { Project } from './Project';

type RepeatSlot = {
  x: number
  y: number
}

const fallbackFontFamilies = ['Noto Color Emoji']

export abstract class Renderer {
  constructor(protected readonly project: Project) {}

  abstract loadImage(uri: string): Promise<CanvasImageSource>
  abstract getLayerCanvas(layer: Layer): HTMLCanvasElement

  async render() {
    console.debug('Start rendering', JSON.stringify(this.project));

    console.debug('Running onBeforeRender hook');
    await this.onBeforeRender();

    const layers = await Promise.all(this.project.layers.map(layer => {
      const canvas = this.getLayerCanvas(layer);

      console.debug('Rendering layer', JSON.stringify(layer));
      return this.renderLayer(canvas, layer);
    }))

    console.debug('Running onAfterRender hook');
    await this.onAfterRender(layers);

    return layers;
  }

  onBeforeRender() {}
  onAfterRender(layers: HTMLCanvasElement[]) {}

  renderLayer(canvas: HTMLCanvasElement, layer: Layer) {
    return this.setupCanvas(canvas, async (ctx) => {
      if (layer.alpha !== undefined) {
        ctx.globalAlpha = layer.alpha;
      }

      await this.withCleanContext(ctx, c => this.renderBackground(c, layer))
      await this.withCleanContext(ctx, c => this.renderImage(c, layer))
      await this.withCleanContext(ctx, c => this.renderText(c, layer))
    });
  }

  protected async setupCanvas(canvas: HTMLCanvasElement, callback: (ctx: CanvasRenderingContext2D) => void) {
    const ctx = canvas.getContext("2d");

    if (!ctx) throw new Error("2D Context not available");

    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    await callback(ctx);

    ctx.restore();
    return canvas;
  }

  protected async withCleanContext(ctx: CanvasRenderingContext2D, callback: (ctx: CanvasRenderingContext2D) => void) {
    ctx.save();

    await callback(ctx);
    
    ctx.restore();
  }

  protected renderBackground(ctx: CanvasRenderingContext2D, layer: Layer) {
    let {
      w = ctx.canvas.width,
      h = ctx.canvas.height,
      x = 0,
      y = 0,
      bg
    } = layer;

    if (bg) {
      ctx.fillStyle = `${bg}`;
      ctx.fillRect(x, y, w, h);
    }
  }

  protected renderText(ctx: CanvasRenderingContext2D, layer: Layer) {
    let {
      x = 0,
      y = 0,
      w: width = ctx.canvas.width,
      h: height = ctx.canvas.height,
      lineH = 1,
      txtAlign = TextAlign.Start,
      valign,
      txt,
      color,
      fontSize = 14,
      fontObject
    } = layer;

    if (!txt || !fontObject) {
      return;
    }

    if (color) {
      ctx.fillStyle = color;
    }

    const fontDeclaration = [
      fontObject.style,
      fontObject.weight,
      `${fontSize}px`,
      [fontObject.family, ...fallbackFontFamilies].map(it => `"${it}"`).join(',')
    ].filter(it => !!it).join(' ');

    ctx.font = fontDeclaration;
    ctx.textAlign = txtAlign as CanvasTextAlign;

    switch(txtAlign) {
      case TextAlign.Center: {
        x += width / 2;
        break;
      }
      case TextAlign.Right: {
        x += width;
        break;
      }
    }

    const lines = txt.split(/\n/)
      .map(line =>this.fitText(ctx, line, width))
      .reduce<string[]>((acc, it) => [...acc, ...it], []);

    const h = +fontSize * +lineH;
    const offset = (h - +fontSize) / 2;
    const textHeight = (lines.length * h);

    switch(valign) {
      case VerticalAlign.Middle: {
        y += ((height - y) / 2) - (textHeight / 2);

        break;
      }
      case VerticalAlign.Bottom: {
        y += height - textHeight;
      }
    }

    const slots = this.getRepeatSlots(ctx, layer.rp, {
      x: +x,
      y: +y,
      width: +width,
      height: +height
    });

    slots.forEach(({ x, y }) => {
      lines.forEach((line, i) => {
        const yi = +y + ((i + 1) * h) - offset;

        ctx.fillText(line, +x, yi);
      });
    });
  }

  protected async renderImage(ctx: CanvasRenderingContext2D, layer: Layer) {
    let {
      x: lx = 0,
      y: ly = 0,
      img,
      valign,
      rp,
      w = ctx.canvas.width,
      h = ctx.canvas.height,
      imgFit
    } = layer;

    if (!img) {
      return;
    }

    const image = await this.loadImage(img);
    const scale = this.getScale(ctx.canvas, image, layer);
    const slots: RepeatSlot[] = this.getRepeatSlots(ctx, rp, {
      x: +lx,
      y: +ly,
      width: +(layer.w || scale.width),
      height: +(layer.h || scale.height)
    });

    slots.forEach(slot => {
      let {x, y} = slot;

      switch(valign) {
        case VerticalAlign.Middle: {
          const offset = (+h - scale.height) / 2;
          y = offset;
          break;
        }
        case VerticalAlign.Bottom: {
          const offset = (+h - scale.height);
          y = offset;
          break;
        }
        case VerticalAlign.Top: {
          x += scale.x;
          y = 0
          break;
        }
        default: {
          x += scale.x;
          y += scale.y;
        }
      }

      ctx.drawImage(image, +x, +y, scale.width, scale.height);
    });
  }

  protected getScale(canvas: HTMLCanvasElement, img: CanvasImageSource, layer: Layer): IntrinsicScale {
    const {
      w = canvas.width,
      h = canvas.height
    } = layer;

    switch (layer.imgFit) {
      case ImageFit.Contain: {
        return contain(+w, +h, +img.width, +img.height);
      }
      case ImageFit.Cover: {
        return cover(+w, +h, +img.width, +img.height);
      }
      default: {
        return {
          width: +(layer.w || img.width),
          height: +(layer.h || img.height),
          x: 0,
          y: 0
        }
      }
    }
  }

  protected fitText(ctx: CanvasRenderingContext2D, text: string, width: number = ctx.canvas.width): string[] {
    if (!text) {
      return [];
    }

    if (ctx.measureText(text).width <= width) {
      return [text];
    }

    const words = text.split(' ');
    const result: string[] = [];
    let curr: string[] = [];

    while(words.length) {
      const word = words.shift()!;

      if (ctx.measureText([...curr, word].join(' ')).width <= width) {
        curr.push(word);
      } else {
        result.push(curr.join(' '));
        curr = [word];
      }
    }

    if (curr.length) {
      result.push(curr.join(' '));
    }

    return result;
  }

  protected getRepeatSlots(
    ctx: CanvasRenderingContext2D,
    pattern: RepeatPattern | string | undefined,
    config: { x: number, y: number, width: number, height: number }
  ): RepeatSlot[] {
    const { x, y, width, height } = config;

    if (!pattern) {
      return [{x, y}];
    }

    const rx = pattern === RepeatPattern.X || pattern === RepeatPattern.XY ? ctx.canvas.width / width : 1;
    const ry = pattern === RepeatPattern.Y || pattern === RepeatPattern.XY ? ctx.canvas.height / height : 1;
    const result: RepeatSlot[] = [];

    for(let ix=0; ix<rx; ix++) {
      for(let iy=0; iy<ry; iy++) {
        result.push({
          x: x + (ix * width),
          y: y + (iy * height)
        });
      }
    }

    return result;
  }
}