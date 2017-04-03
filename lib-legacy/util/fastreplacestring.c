#include <stdlib.h>
#include <stdio.h>
#include <sys/stat.h>
#include <string.h>

#if (__STDC_VERSION__ >= 199901L)
#include <stdint.h>
#endif

// source: https://www.joelonsoftware.com/2001/12/11/back-to-basics/
char* mystrcat( char* dest, char* src )
{
     while ((*dest)) dest++;
     while ((*dest++ = *src++));
     return --dest;
}

int main(int arg, char **argv) {
    FILE *in;
    FILE *out;
    char *mystr = NULL;
    size_t r;
    long int filelen;
    struct stat fileStat;
    // const char* inFile = "/Users/Iwan/Development/FastReplaceString/test/small.txt";
    // const char* outFile = "/Users/Iwan/Development/FastReplaceString/test/smallc.txt";
	// const char* inFile = "/Users/Iwan/.opam/4.02.3/bin/ocamlopt";
	// const char* outFile = "/Users/Iwan/.opam/4.02.3/bin/ocamlopt6";

	const char* filename;
	filename = argv[1];
	const char* old;
	const char* new;

	old = argv[2];
	new = argv[3];

	const char* inFile = filename;
    const char* outFile = filename;

    if(stat(inFile, &fileStat) < 0){
		printf("stat problem \n");
		exit(1);
    }
    
    filelen = fileStat.st_size;
    
    in = fopen(inFile, "rb");
//    if (fseek(in, 0, SEEK_END) > 0 || (filelen = ftell(in)) == -1L) {
//		printf("fseek problem \n");
//		filelen = 66;
//	}

//    freopen(inFile, "rb", in);
	if ((mystr = malloc(filelen)) == NULL) {
		printf("mystr = malloc problem \n");
		exit(1);
	}

	/* Read in as much of specified file as possible */
	if ((r = fread(mystr, 1, filelen, in)) == 0) {
		printf("fread problem \n");
		exit(1);
	}

    fclose(in);

	char filename_stage[strlen(argv[1]) + 9];
	char *p = filename_stage;
	filename_stage[0] = '\0';
	p = mystrcat(filename_stage, argv[1]);
	p = mystrcat(filename_stage, ".rewrite");

    /* Increment positions cache size initially by this number. */
	size_t cache_sz_inc = 16;
	/* Thereafter, each time capacity needs to be increased,
	 * multiply the increment by this factor. */
	const size_t cache_sz_inc_factor = 3;
	#if (__STDC_VERSION__ >= 199901L)
	uintptr_t *pos_cache_tmp, *pos_cache = NULL;
	#else
	ptrdiff_t *pos_cache_tmp, *pos_cache = NULL;
	#endif
	size_t cache_sz = 0;

	char *ret = NULL;
	char *temp = NULL;
	const char *substring = NULL;
	size_t m, sLen;	
	size_t oldLen = strlen(old);
	size_t newLen = strlen(new);

	printf("filelen: %zu\n", filelen);
	printf("oldLen: %zu\n", oldLen);
	printf("newLen: %zu\n", newLen);
	size_t newFilelen;
	
	size_t c = 0; 
	const char *ps2, *ps = mystr;
	
	// int ccache[100000];

	/* Find all matches and cache their positions. */
	while((ps2 = strstr(ps, old)) != NULL) {
		c++;

		/* Increase the cache size when necessary. */
		if (cache_sz < c) {
			cache_sz += cache_sz_inc;
			pos_cache_tmp = realloc(pos_cache, sizeof(*pos_cache) * cache_sz);
			if (pos_cache_tmp == NULL) {
			} else pos_cache = pos_cache_tmp;
			cache_sz_inc *= cache_sz_inc_factor;		
		}
		pos_cache[c-1] = ps2 - mystr;
		ps = ps2 + oldLen;
	}

	if (c == 0) {
		newFilelen = filelen;
		ret = malloc(newFilelen);
		memcpy(ret, mystr, newFilelen);
	} else {
		const char *pstr = mystr;
		newFilelen = filelen + c * (newLen - oldLen);
		ret = malloc(newFilelen);
		int i, copyLen;

		temp = ret;
		
		size_t j = pos_cache[0];
		size_t nextPos;
		
		memcpy(temp, mystr, j);
		temp += j;
		for(i = 0; i < c; i++) {
			memcpy(temp, new, newLen);
			temp += newLen;
			pstr = mystr + j + oldLen;
			
			if (i == ((int) (c - 1))){
				if (oldLen > newFilelen) {
					copyLen = 0;
				} else {
					copyLen = newFilelen - j - oldLen;
				}
				memcpy(temp, pstr, copyLen);
				temp += copyLen;
			} else {
				nextPos = pos_cache[i+1]; 
				copyLen = nextPos - j - oldLen; 
				memcpy(temp, pstr, copyLen);
				temp += copyLen;
			j = nextPos;
			}
			
			
		}
	}

	out = fopen(filename_stage, "wb");

    fwrite(ret, 1, newFilelen, out);

	rename(filename_stage, filename);
    chmod(filename, fileStat.st_mode);

    fclose(out);

    return 0;
}
